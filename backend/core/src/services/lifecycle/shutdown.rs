use crate::context::AppHandle;
use log::{debug, error, info, warn};
use serde_json::json;
use std::time::Duration;

use crate::{
    rclone::{
        backend::types::Backend,
        backend::{BackendManager, routing_transport::RoutingTransport},
        commands::{job::stop_job_on_backend, mount::unmount_all_remotes, serve::stop_all_serves},
        endpoints::mount,
    },
    services::{automation::engine::AutomationScheduler, bridge},
    utils::types::{events::APP_SHUTTING_DOWN, state::RcloneState},
};

/// Longest shutdown waits for in-flight initialization before tearing services down anyway.
const INITIALIZATION_WAIT: Duration = Duration::from_secs(5);

/// Budget for stopping jobs and serves.
const STOP_WAIT: Duration = Duration::from_secs(5);
/// Unmount budget when the app only sends the batch and does not check the result.
const UNMOUNT_WAIT: Duration = Duration::from_secs(5);
/// Unmount budget on Windows, shared by the batch, the verification and the retries.
const VERIFIED_UNMOUNT_WAIT: Duration = Duration::from_secs(30);
const UNMOUNT_RETRY_INTERVAL: Duration = Duration::from_millis(250);

/// Room for the steps without a timeout of their own (watchers, staged updates, host cleanup).
const CLEANUP_MARGIN: Duration = Duration::from_secs(10);

/// Engine shutdown must outlast the graceful-exit wait, otherwise its forced kill is cut
/// off before it can run.
#[cfg(not(feature = "librclone"))]
const ENGINE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(
    crate::rclone::binaries::process_common::GRACEFUL_SHUTDOWN_TIMEOUT.as_secs() + 2,
);
#[cfg(feature = "librclone")]
const ENGINE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Default)]
struct ShutdownState(tokio::sync::OnceCell<()>);

impl ShutdownState {
    /// Runs the cleanup once. Callers must not cancel it: the native event loop stays blocked
    /// until it has finished, so the deadline lives here and an expired cleanup still counts
    /// as done.
    async fn run(&self, deadline: Duration, cleanup: impl std::future::Future<Output = ()>) {
        self.0
            .get_or_init(|| async {
                if tokio::time::timeout(deadline, cleanup).await.is_err() {
                    error!("Shutdown exceeded its {deadline:?} deadline; exiting anyway");
                }
            })
            .await;
    }
}

/// Concurrent exit requests share one completed cleanup sequence. Every step is bounded, so
/// callers wait for it without a timeout of their own.
pub async fn handle_shutdown(app_handle: AppHandle) {
    app_handle.manage(ShutdownState::default());
    let state = app_handle.state::<ShutdownState>();
    // Windows unmounts drives asynchronously, so the desktop app waits until rclone no longer
    // lists them. The standalone server keeps the quick batch.
    let verified_unmount =
        (cfg!(windows) && app_handle.product().mode == "desktop").then_some(VERIFIED_UNMOUNT_WAIT);
    let deadline = INITIALIZATION_WAIT
        + verified_unmount.unwrap_or(UNMOUNT_WAIT)
        + ENGINE_SHUTDOWN_TIMEOUT
        + CLEANUP_MARGIN;
    state
        .run(deadline, shutdown(app_handle, verified_unmount))
        .await;
}

/// Starting cleanup is not permission for the native event loop to exit.
pub fn is_shutdown_complete(app: &AppHandle) -> bool {
    app.try_state::<ShutdownState>()
        .is_some_and(|state| state.0.get().is_some())
}

/// Unmounts everything, then keeps retrying whatever rclone still lists until nothing is left.
/// It has no deadline of its own; the caller bounds it.
async fn unmount_until_clear(app: AppHandle, backend: Backend) -> Result<(), String> {
    let transport = &*RoutingTransport::for_backend(app, backend);
    // rclone stops the batch at the first error. Check for remaining mounts
    // even if the batch reports a failure.
    if let Err(error) = transport.rpc(mount::UNMOUNTALL, None).await {
        debug!("Initial unmount batch failed during shutdown: {error}");
    }

    loop {
        // A missing or malformed list is an error, never "nothing mounted".
        let response = transport
            .rpc(mount::LISTMOUNTS, None)
            .await
            .map_err(|error| error.to_string())?;
        let remaining = response["mountPoints"]
            .as_array()
            .ok_or("Invalid mount list during shutdown")?
            .iter()
            .map(|mount| mount["MountPoint"].as_str())
            .collect::<Option<Vec<_>>>()
            .ok_or("Invalid mount point during shutdown")?;
        if remaining.is_empty() {
            return Ok(());
        }
        // The last of these lines names what was still mounted if the deadline cuts us off.
        warn!("Still mounted during shutdown, retrying: {remaining:?}");
        // One stuck mount must not hold back the others.
        futures::future::join_all(remaining.iter().map(|mount_point| async move {
            let request = json!({ "mountPoint": mount_point });
            if let Err(error) = transport.rpc(mount::UNMOUNT, Some(&request)).await {
                debug!("Unmount retry failed for {mount_point}: {error}");
            }
        }))
        .await;
        tokio::time::sleep(UNMOUNT_RETRY_INTERVAL).await;
    }
}

fn log_step<T>(step: &str, result: Result<Result<T, String>, tokio::time::error::Elapsed>) {
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => error!("Failed to {step}: {error}"),
        Err(_) => error!("Timed out trying to {step}"),
    }
}

/// `verified_unmount` is the unmount budget of a platform that checks the result.
async fn shutdown(app_handle: AppHandle, verified_unmount: Option<Duration>) {
    info!("Beginning shutdown sequence...");

    let runtime = app_handle.state::<RcloneState>();
    runtime.set_shutting_down();
    // Before the wait below, so the closing screen appears at once.
    bridge::emit(APP_SHUTTING_DOWN, ());
    // Let in-flight initialization finish before tearing its services down. A slow
    // auto-start must not keep the app from exiting.
    let _startup =
        match tokio::time::timeout(INITIALIZATION_WAIT, runtime.initialization_lock.lock()).await {
            Ok(guard) => Some(guard),
            Err(_) => {
                error!("Initialization is still running; shutting down without waiting for it");
                None
            }
        };

    let scheduler_state = app_handle.state::<AutomationScheduler>();

    if let Some(watcher_manager) =
        app_handle.try_state::<crate::services::automation::watcher::WatcherManager>()
    {
        watcher_manager.stop_all().await;
    }

    // Only the Local backend is ours to clean up: its engine stops with the app, while a remote
    // backend keeps running its mounts, jobs and serves for whoever else uses it.
    let local = app_handle.state::<BackendManager>().get_local().await;

    // Run cleanup tasks concurrently with individual timeouts.
    let (unmount_result, stop_jobs_result, stop_serves_result) = tokio::join!(
        async {
            match verified_unmount {
                Some(wait) => {
                    tokio::time::timeout(
                        wait,
                        unmount_until_clear(app_handle.clone(), local.clone()),
                    )
                    .await
                }
                None => {
                    tokio::time::timeout(UNMOUNT_WAIT, async {
                        unmount_all_remotes(
                            app_handle.clone(),
                            crate::rclone::commands::common::OperationContext::Shutdown,
                        )
                        .await
                        .map(drop)
                    })
                    .await
                }
            }
        },
        tokio::time::timeout(
            STOP_WAIT,
            stop_active_jobs(app_handle.clone(), vec![local.clone()]),
        ),
        tokio::time::timeout(
            STOP_WAIT,
            stop_all_serves(
                app_handle.clone(),
                crate::rclone::commands::common::OperationContext::Shutdown,
            ),
        ),
    );

    // Released only now: on Windows the shutdown block reason is what holds the OS back while
    // the drives are being unmounted.
    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    if let Some(power_state) = app_handle.try_state::<crate::services::power::PowerInhibitorState>()
    {
        power_state.release().await;
    }

    crate::services::lifecycle::auto_updater::stop_auto_updater(&app_handle);

    match scheduler_state.stop().await {
        Ok(()) => info!("Cron scheduler stopped."),
        Err(e) => error!("Failed to stop cron scheduler: {e}"),
    }

    log_step("unmount remotes", unmount_result);
    log_step("stop jobs", stop_jobs_result);
    log_step("stop serves", stop_serves_result);

    // Shut down the rclone engine with a hard timeout.
    let app_clone = app_handle.clone();
    let engine_result = tokio::time::timeout(ENGINE_SHUTDOWN_TIMEOUT, async move {
        let engine_state = app_clone.state::<crate::utils::types::state::EngineState>();
        engine_state.lock().await.shutdown(&app_clone).await;
        Ok::<(), String>(())
    })
    .await;

    match engine_result {
        Ok(Ok(())) => info!("Engine shutdown completed."),
        Ok(Err(e)) => error!("Engine shutdown failed: {e}"),
        #[cfg(not(feature = "librclone"))]
        Err(_) => {
            error!("Engine shutdown timed out — force-killing rclone processes");
            let port = local.port;
            let _ = crate::utils::spawn_blocking(move || {
                crate::utils::process::process_manager::kill_processes_on_port(port)
            })
            .await;
        }
        #[cfg(feature = "librclone")]
        Err(_) => {}
    }

    // Clear the in-memory config password so late-spawned processes can't read it.
    crate::services::security::rclone_env::clear_config_password();
    debug!("Cleared RCLONE_CONFIG_PASS from the environment");

    // Clear temporary file preview/viewer cache files
    app_handle.host().cleanup();

    #[cfg(not(feature = "librclone"))]
    apply_pending_updates(&app_handle).await;
}

/// Runs the shutdown sequence, then exits the application.
pub async fn shutdown_app(app: AppHandle) {
    handle_shutdown(app.clone()).await;
    info!("Shutdown completed.");
    app.exit(0);
}

/// Applies any staged updates (app or rclone) during shutdown.
#[cfg(not(feature = "librclone"))]
async fn apply_pending_updates(app_handle: &AppHandle) {
    // Rclone update (binary swap — only available on desktop).
    #[cfg(not(feature = "librclone"))]
    if let Err(e) =
        crate::rclone::binaries::updater::apply_rclone_update_if_staged(app_handle).await
    {
        error!("Failed to apply rclone update during shutdown: {e}");
    }
}

/// Stops the active jobs of every backend, for a user request.
pub async fn stop_all_active_jobs(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let mut backends = Vec::new();
    for info in manager.list_all().await {
        backends.extend(manager.get(&info.name).await);
    }
    stop_active_jobs(app, backends).await
}

async fn stop_active_jobs(app: AppHandle, backends: Vec<Backend>) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let mut tasks = Vec::new();
    for backend in backends {
        for job in manager.job_cache_for(&backend.name).get_active_jobs().await {
            let app = app.clone();
            let backend = backend.clone();
            tasks.push(crate::utils::spawn(async move {
                stop_job_on_backend(app, backend, job.jobid).await
            }));
        }
    }

    let errors: Vec<String> = futures::future::join_all(tasks)
        .await
        .into_iter()
        .filter_map(|r| match r {
            Ok(Err(e)) => Some(e),
            Err(e) => Some(format!("Task panicked: {e}")),
            Ok(Ok(())) => None,
        })
        .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}

/// Stops every active job for a user request (tray or notification action) and says so.
pub async fn stop_all_active_jobs_with_notice(app: AppHandle) {
    use crate::utils::app::notification::{NotificationEvent, SystemStage, notify};
    match stop_all_active_jobs(app.clone()).await {
        Ok(()) => notify(&app, NotificationEvent::System(SystemStage::AllJobsStopped)),
        Err(e) => error!("Failed to stop all active jobs: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{ShutdownState, is_shutdown_complete};
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    const DEADLINE: Duration = Duration::from_secs(10);

    #[tokio::test]
    async fn concurrent_and_later_requests_wait_for_one_cleanup() {
        let state = ShutdownState::default();
        let completed = AtomicUsize::new(0);
        let cleanup = || async {
            tokio::task::yield_now().await;
            completed.fetch_add(1, Ordering::SeqCst);
        };
        tokio::join!(state.run(DEADLINE, cleanup()), async {
            state.run(DEADLINE, cleanup()).await;
            assert_eq!(completed.load(Ordering::SeqCst), 1);
        });
        state.run(DEADLINE, cleanup()).await;
        assert_eq!(completed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn host_exit_waits_for_cleanup() {
        let app = crate::context::AppHandle::default();
        assert!(!is_shutdown_complete(&app));
        app.manage(ShutdownState::default());
        let state = app.state::<ShutdownState>();
        assert!(!is_shutdown_complete(&app));
        state
            .run(DEADLINE, async { assert!(!is_shutdown_complete(&app)) })
            .await;
        assert!(is_shutdown_complete(&app));
    }

    #[tokio::test]
    async fn an_expired_cleanup_still_lets_the_host_exit() {
        let app = crate::context::AppHandle::default();
        app.manage(ShutdownState::default());
        app.state::<ShutdownState>()
            .run(Duration::from_millis(50), std::future::pending())
            .await;
        assert!(is_shutdown_complete(&app));
    }

    #[cfg(not(feature = "librclone"))]
    mod unmount {
        use super::{ShutdownState, is_shutdown_complete};
        use crate::context::AppHandle;
        use crate::rclone::backend::{BackendManager, http_transport::RcHttpBackend};
        use crate::services::automation::engine::AutomationScheduler;
        use crate::utils::{
            constants::LOCAL_BACKEND_NAME,
            types::{
                state::{EngineState, RcApiEngine, RcloneState},
                updater::{RcloneUpdaterState, UpdateState},
            },
        };
        use serde_json::{Value, json};
        use std::{sync::Arc, time::Duration};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::{TcpListener, TcpStream},
            task::JoinHandle,
            time::timeout,
        };

        async fn reply(socket: &mut TcpStream, status: u16, body: Value) {
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }

        async fn receive(listener: &TcpListener) -> (TcpStream, String, Value) {
            timeout(Duration::from_secs(2), async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let body_start = loop {
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        break end + 4;
                    }
                    assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
                };
                let headers = std::str::from_utf8(&request[..body_start]).unwrap();
                let mut lines = headers.lines();
                let mut request_line = lines.next().unwrap().split_whitespace();
                assert_eq!(request_line.next(), Some("POST"));
                let endpoint = request_line.next().unwrap().to_string();
                let length = lines
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
                while request.len() < body_start + length {
                    assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
                }
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&request[body_start..body_start + length]).unwrap()
                };
                (socket, endpoint, body)
            })
            .await
            .expect("expected an rclone request")
        }

        struct ShutdownTest {
            app: AppHandle,
            task: JoinHandle<()>,
            listener: TcpListener,
        }

        impl ShutdownTest {
            async fn request(&self, path: &str, payload: Value) -> TcpStream {
                let (socket, actual_path, actual_payload) = receive(&self.listener).await;
                assert_eq!(actual_path, path);
                assert_eq!(actual_payload, payload);
                socket
            }

            async fn respond(&self, path: &str, payload: Value, status: u16, body: Value) {
                reply(&mut self.request(path, payload).await, status, body).await;
            }

            /// Answers requests that rclone may receive in any order, matching on the payload.
            async fn respond_unordered(&self, path: &str, replies: Vec<(Value, u16, Value)>) {
                let mut pending = replies;
                while !pending.is_empty() {
                    let (mut socket, actual_path, payload) = receive(&self.listener).await;
                    assert_eq!(actual_path, path);
                    let index = pending
                        .iter()
                        .position(|(expected, ..)| *expected == payload)
                        .expect("unexpected request payload");
                    let (_, status, body) = pending.remove(index);
                    reply(&mut socket, status, body).await;
                }
            }

            async fn assert_waiting(&self) {
                assert!(
                    self.app
                        .state::<EngineState>()
                        .lock()
                        .await
                        .phase
                        .is_operational()
                );
                assert!(!is_shutdown_complete(&self.app));
            }

            async fn finish(self) {
                timeout(Duration::from_secs(2), self.task)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    !self
                        .app
                        .state::<EngineState>()
                        .lock()
                        .await
                        .phase
                        .is_operational()
                );
                assert!(is_shutdown_complete(&self.app));
            }
        }

        async fn begin_shutdown(verified_unmount: Option<Duration>) -> (ShutdownTest, TcpStream) {
            begin_shutdown_with(verified_unmount, None).await
        }

        /// `active_remote` is the port of a remote backend the user has switched to.
        async fn begin_shutdown_with(
            verified_unmount: Option<Duration>,
            active_remote: Option<u16>,
        ) -> (ShutdownTest, TcpStream) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let app = AppHandle::default();
            let manager = BackendManager::new();
            let mut backend = manager.get(LOCAL_BACKEND_NAME).await.unwrap();
            backend.port = listener.local_addr().unwrap().port();
            // Prevent engine process cleanup targeting the test listener.
            backend.is_local = false;
            manager.update(LOCAL_BACKEND_NAME, backend).await.unwrap();
            if let Some(port) = active_remote {
                let directory = tempfile::tempdir().unwrap();
                let mut builder = rcman::SettingsManager::builder("shutdown-test", "1.0.0")
                    .with_config_dir(directory.path())
                    .with_schema::<crate::services::settings::schema::AppSettings>();
                for name in crate::utils::constants::ENGINE_SUB_SETTINGS {
                    builder = builder.with_sub_settings(
                        rcman::SubSettingsConfig::singlefile(name).with_profiles(),
                    );
                }
                let settings = builder.build().unwrap();
                let remote =
                    crate::rclone::backend::types::Backend::new_remote("NAS", "127.0.0.1", port);
                manager
                    .add(
                        &settings,
                        remote,
                        crate::rclone::backend::CopySources::default(),
                    )
                    .await
                    .unwrap();
                manager.switch_to(&settings, "NAS").await.unwrap();
            }
            app.manage(manager);
            app.manage(RcloneState::new(
                crate::rclone::backend::types::rc_client(),
                Arc::new(RcHttpBackend::new(app.clone())),
            ));
            app.manage(AutomationScheduler::new());
            let mut engine = RcApiEngine::default();
            engine.mark_running();
            app.manage(EngineState::new(engine));
            let updater = RcloneUpdaterState::default();
            updater.data.lock().state = UpdateState::Downloading;
            app.manage(updater);
            app.manage(ShutdownState::default());
            let running = app.clone();
            let task = crate::utils::spawn(async move {
                running
                    .state::<ShutdownState>()
                    .run(
                        Duration::from_secs(30),
                        super::super::shutdown(running.clone(), verified_unmount),
                    )
                    .await;
            });

            let mut batch = None;
            let mut serve_stopped = false;
            for _ in 0..2 {
                let (mut socket, endpoint, _) = receive(&listener).await;
                if endpoint == "/serve/stopall" {
                    assert!(!serve_stopped);
                    reply(&mut socket, 200, json!({})).await;
                    serve_stopped = true;
                } else {
                    assert_eq!(endpoint, "/mount/unmountall");
                    assert!(batch.replace(socket).is_none());
                }
            }
            assert!(serve_stopped);
            (
                ShutdownTest {
                    app,
                    task,
                    listener,
                },
                batch.unwrap(),
            )
        }

        #[tokio::test]
        async fn shutdown_finishes_promptly_when_the_batch_leaves_no_mounts() {
            let (test, mut batch) = begin_shutdown(Some(Duration::from_secs(10))).await;
            reply(&mut batch, 200, json!({})).await;
            let mut list = test.request("/mount/listmounts", Value::Null).await;
            test.assert_waiting().await;
            reply(&mut list, 200, json!({"mountPoints": []})).await;
            test.finish().await;
        }

        #[tokio::test]
        async fn shutdown_retries_only_mounts_that_rclone_still_lists() {
            let (test, mut batch) = begin_shutdown(Some(Duration::from_secs(10))).await;
            reply(&mut batch, 500, json!({"error": "Unmount interrupted"})).await;
            let folder = r"D:\Dáta a súbory";
            test.respond("/mount/listmounts", Value::Null, 200, json!({
                "mountPoints": [{"Fs": "drive:", "MountPoint": "X:"}, {"Fs": "nas:", "MountPoint": folder}]
            })).await;
            test.respond_unordered(
                "/mount/unmount",
                vec![
                    (json!({"mountPoint": "X:"}), 500, json!({"error": "Busy"})),
                    (json!({"mountPoint": folder}), 200, json!({})),
                ],
            )
            .await;
            test.respond(
                "/mount/listmounts",
                Value::Null,
                200,
                json!({
                    "mountPoints": [{"Fs": "drive:", "MountPoint": "X:"}]
                }),
            )
            .await;
            test.respond(
                "/mount/unmount",
                json!({"mountPoint": "X:"}),
                200,
                json!({}),
            )
            .await;
            let mut list = test.request("/mount/listmounts", Value::Null).await;
            test.assert_waiting().await;
            reply(&mut list, 200, json!({"mountPoints": []})).await;
            test.finish().await;
        }

        #[tokio::test]
        async fn shutdown_waits_for_a_slow_windows_unmount_before_stopping_engine() {
            let (mut test, mut batch) =
                begin_shutdown(Some(super::super::VERIFIED_UNMOUNT_WAIT)).await;

            assert!(
                timeout(Duration::from_secs(6), &mut test.task)
                    .await
                    .is_err()
            );
            test.assert_waiting().await;
            reply(&mut batch, 200, json!({})).await;
            test.respond(
                "/mount/listmounts",
                Value::Null,
                200,
                json!({"mountPoints": []}),
            )
            .await;
            test.finish().await;
        }

        #[tokio::test]
        async fn shutdown_can_finish_when_unmount_never_replies() {
            let (test, _batch) = begin_shutdown(Some(Duration::from_millis(500))).await;
            test.assert_waiting().await;
            test.finish().await;
        }

        #[tokio::test]
        async fn shutdown_timeout_includes_a_stalled_mount_list() {
            let (test, mut batch) = begin_shutdown(Some(Duration::from_millis(800))).await;
            reply(&mut batch, 200, json!({})).await;
            let _list = test.request("/mount/listmounts", Value::Null).await;
            test.assert_waiting().await;
            test.finish().await;
        }

        #[tokio::test]
        async fn shutdown_timeout_includes_a_stalled_retry() {
            let (test, mut batch) = begin_shutdown(Some(Duration::from_millis(800))).await;
            reply(&mut batch, 200, json!({})).await;
            test.respond(
                "/mount/listmounts",
                Value::Null,
                200,
                json!({
                    "mountPoints": [{"Fs": "drive:", "MountPoint": "X:"}]
                }),
            )
            .await;
            let _retry = test
                .request("/mount/unmount", json!({"mountPoint": "X:"}))
                .await;
            test.assert_waiting().await;
            test.finish().await;
        }

        #[tokio::test]
        async fn repeated_unmount_failures_do_not_extend_the_deadline() {
            timeout(Duration::from_secs(3), async {
                let (test, mut batch) = begin_shutdown(Some(Duration::from_secs(2))).await;
                // Spend some of the budget in the batch, then verify a stalled
                // retry only gets the time left over.
                tokio::time::sleep(Duration::from_millis(900)).await;
                reply(&mut batch, 200, json!({})).await;
                let remaining = json!({"mountPoints": [{"Fs": "drive:", "MountPoint": "X:"}]});
                for _ in 0..2 {
                    test.respond("/mount/listmounts", Value::Null, 200, remaining.clone())
                        .await;
                    test.respond(
                        "/mount/unmount",
                        json!({"mountPoint": "X:"}),
                        500,
                        json!({"error": "Busy"}),
                    )
                    .await;
                }
                test.respond("/mount/listmounts", Value::Null, 200, remaining)
                    .await;
                let _retry = test
                    .request("/mount/unmount", json!({"mountPoint": "X:"}))
                    .await;
                test.assert_waiting().await;
                test.finish().await;
            })
            .await
            .expect("retries must share the shutdown deadline");
        }

        #[tokio::test]
        async fn shutdown_uses_fallback_when_the_mount_list_is_invalid_or_unavailable() {
            for (status, body) in [
                (200, json!({})),
                (200, json!({"mountPoints": null})),
                (200, json!({"mountPoints": [{"Fs": "drive:"}]})),
                (500, json!({"error": "Could not list mounts"})),
            ] {
                let (test, mut batch) = begin_shutdown(Some(Duration::from_secs(10))).await;
                reply(&mut batch, 200, json!({})).await;
                test.respond("/mount/listmounts", Value::Null, status, body)
                    .await;
                test.finish().await;
            }
        }

        #[tokio::test]
        async fn shutdown_leaves_an_active_remote_backend_alone() {
            let remote = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = remote.local_addr().unwrap().port();
            for verified_unmount in [Some(Duration::from_secs(10)), None] {
                let (test, mut batch) = begin_shutdown_with(verified_unmount, Some(port)).await;
                reply(&mut batch, 200, json!({})).await;
                if verified_unmount.is_some() {
                    test.respond(
                        "/mount/listmounts",
                        Value::Null,
                        200,
                        json!({"mountPoints": []}),
                    )
                    .await;
                }
                test.finish().await;
            }
            assert!(
                timeout(Duration::from_millis(200), remote.accept())
                    .await
                    .is_err(),
                "a remote backend must not receive shutdown requests"
            );
        }

        #[tokio::test]
        async fn shutdown_without_windows_verification_keeps_the_batch_only() {
            let (test, mut batch) = begin_shutdown(None).await;
            reply(&mut batch, 200, json!({})).await;
            test.finish().await;
        }
    }
}
