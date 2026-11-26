//! Startup routines for auto-starting profiles (mount, serve, sync, etc.)
//!
//! This module provides the `autostart_profiles` function that runs on app startup
//! to automatically start any profiles that are configured with autoStart: true

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use crate::{
    rclone::{
        backend::types::Backend,
        commands::{
            mount::mount_remote_profile, serve::start_serve_profile, sync::start_profile_batch,
        },
        state::automations::AutomationsCache,
    },
    utils::{
        types::origin::Origin,
        types::remotes::{OperationType, ProfileConfig, ProfileParams, RemoteSettings},
    },
};
use log::{info, warn};
use std::collections::HashMap;
use std::time::Duration;

/// Auto-start all profiles that have autoStart: true
/// This is called during app initialization.
/// Profiles are started in parallel for faster startup. Profiles with an
/// `autoStartDelay` run detached, so they never hold up initialization.
///
/// `snapshot` is the backend and remote profiles startup already read; without one they
/// are read here.
pub async fn autostart_profiles(
    app: AppHandle,
    snapshot: Option<(Backend, HashMap<String, RemoteSettings>)>,
) {
    info!("Starting auto-start profiles check...");
    let (backend, settings_map) = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            let manager = app.state::<AppSettingsManager>();
            app.state::<crate::rclone::backend::BackendManager>()
                .active_remote_configs(manager.inner())
                .await
        }
    };

    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    for (remote_name, settings) in &settings_map {
        for &op_type in OperationType::ALL {
            if let Some(configs) = settings.get_configs(op_type) {
                push_auto_start_tasks(
                    &mut tasks,
                    &app,
                    &backend.name,
                    remote_name,
                    configs,
                    op_type,
                );
            }
        }
    }

    let task_count = tasks.len();
    if task_count > 0 {
        info!("Starting {task_count} auto-start profile(s) in parallel...");

        let _ = futures::future::join_all(tasks).await;
    }

    info!("Auto-start profiles check complete");
}

/// Runs an auto-start on its own task once its delay has passed, and shows on the automation
/// `automation_id` when that is while it waits. The run is skipped when the app began shutting
/// down in the meantime.
pub(crate) fn spawn_auto_start<F>(
    app: &AppHandle,
    delay_secs: u64,
    automation_id: String,
    run: F,
) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let app = app.clone();
    crate::utils::spawn(async move {
        let cache = app.state::<AutomationsCache>();
        let set_due = |due| {
            cache.update_automation(&automation_id, move |automation| {
                automation.auto_start_at = due;
            })
        };
        if delay_secs > 0 {
            let _ = set_due(Some(chrono::Utc::now() + Duration::from_secs(delay_secs))).await;
        }
        let still_running = app
            .state::<crate::utils::types::state::RcloneState>()
            .sleep_unless_shutdown(Duration::from_secs(delay_secs))
            .await;
        if delay_secs > 0 {
            let _ = set_due(None).await;
        }
        if still_running {
            run.await;
        }
    })
}

/// Runs what starts with the app and records on its automation how that went. `run` gets the
/// execution id and says whether a job reports the end of the work (`true`) or the work is done
/// once it has started (`false`). One that is already running or turned off is not started.
/// Without automations (their setup failed at startup) the work still starts, unrecorded.
pub(crate) async fn run_recorded<Fut>(
    app: &AppHandle,
    backend_name: &str,
    automation_id: &str,
    run: impl FnOnce(Option<String>) -> Fut,
) -> Result<(), String>
where
    Fut: std::future::Future<Output = Result<bool, String>>,
{
    let cache = app.state::<AutomationsCache>();
    let started = match cache
        .try_start_automation(automation_id, backend_name, None, false)
        .await
    {
        Ok(started) => started,
        Err(_) if cache.get_automation(automation_id).await.is_none() => {
            return run(None).await.map(drop);
        }
        Err(error) => {
            info!("Not auto-starting '{automation_id}': {error}");
            return Ok(());
        }
    };
    let Some(execution_id) = started.and_then(|automation| automation.execution_id) else {
        info!("Not auto-starting '{automation_id}': it is already running");
        return Ok(());
    };
    // The work announces itself, as work of the start; the automation only records it.
    let outcome = run(Some(execution_id.clone())).await;
    if !matches!(outcome, Ok(true)) {
        let _ = cache
            .update_automation(automation_id, |automation| {
                if automation.execution_id.as_deref() != Some(execution_id.as_str()) {
                    return;
                }
                match &outcome {
                    Ok(_) => automation.mark_success(),
                    Err(error) => automation.mark_ended_with(error.clone()),
                }
            })
            .await;
    }
    outcome.map(drop)
}

/// Spawn each enabled profile with the backend from the startup snapshot.
/// Delayed profiles are not added to `tasks`, so the caller does not wait for them.
fn push_auto_start_tasks(
    tasks: &mut Vec<tokio::task::JoinHandle<()>>,
    app: &AppHandle,
    backend_name: &str,
    remote_name: &str,
    configs: &HashMap<String, ProfileConfig>,
    operation: OperationType,
) {
    for (profile_name, config) in configs {
        if !config.app.auto_start {
            continue;
        }
        let params = ProfileParams {
            remote_name: remote_name.to_string(),
            profile_name: profile_name.clone(),
            backend_name: Some(backend_name.to_string()),
            source: Some(Origin::Startup),
            no_cache: Some(false),
            scoped_targets: None,
            execute_id: None,
        };
        let delay = config.app.auto_start_delay.unwrap_or(0);
        if delay > 0 {
            info!(
                "Delaying auto-start of {operation} {} profile '{}' by {delay}s",
                params.remote_name, params.profile_name
            );
        }
        let task_app = app.clone();
        let backend_name = backend_name.to_string();
        let automation_id = AutomationsCache::generate_automation_id(
            &backend_name,
            &params.remote_name,
            &operation,
            &params.profile_name,
        );
        let handle = spawn_auto_start(app, delay, automation_id.clone(), async move {
            let app = task_app;
            let remote = params.remote_name.clone();
            let profile = params.profile_name.clone();
            let launch_app = app.clone();
            // Only a transfer's job takes the execution id and reports its end; a mount or a
            // serve is done once it runs.
            let result = run_recorded(
                &app,
                &backend_name,
                &automation_id,
                |execution_id| async move {
                    let mut params = params;
                    params.execute_id = execution_id;
                    match operation {
                        OperationType::Mount => mount_remote_profile(launch_app, params)
                            .await
                            .map(|()| false),
                        OperationType::Serve => {
                            start_serve_profile(launch_app, params).await.map(|_| false)
                        }
                        transfer => start_profile_batch(launch_app, transfer, params)
                            .await
                            .map(|_| true),
                    }
                },
            )
            .await;
            match result {
                Ok(()) => info!("Auto-started {operation}: {remote} profile '{profile}'"),
                Err(error) => {
                    warn!("Failed to auto-start {operation} {remote} profile '{profile}': {error}")
                }
            }
        });
        if delay == 0 {
            tasks.push(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::routing_transport::RoutingTransport;
    use crate::utils::types::state::RcloneState;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    fn app_with_state() -> AppHandle {
        let app = AppHandle::default();
        app.manage(RcloneState::new(
            reqwest::Client::new(),
            Arc::new(RoutingTransport::new(app.clone())),
        ));
        app.manage(AutomationsCache::new());
        app
    }

    fn mark(ran: &Arc<AtomicBool>) -> impl std::future::Future<Output = ()> + Send + 'static {
        let ran = ran.clone();
        async move { ran.store(true, Ordering::SeqCst) }
    }

    #[tokio::test]
    async fn runs_immediately_without_a_delay() {
        let app = app_with_state();
        let ran = Arc::new(AtomicBool::new(false));

        spawn_auto_start(&app, 0, "none".into(), mark(&ran))
            .await
            .unwrap();

        assert!(ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn is_skipped_when_shutdown_already_began() {
        let app = app_with_state();
        app.state::<RcloneState>().set_shutting_down();
        let ran = Arc::new(AtomicBool::new(false));

        spawn_auto_start(&app, 0, "none".into(), mark(&ran))
            .await
            .unwrap();

        assert!(!ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn shutdown_during_the_delay_ends_the_wait_without_running() {
        let app = app_with_state();
        let ran = Arc::new(AtomicBool::new(false));
        let handle = spawn_auto_start(&app, 3600, "none".into(), mark(&ran));

        tokio::time::sleep(Duration::from_millis(20)).await;
        app.state::<RcloneState>().set_shutting_down();

        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("a delayed auto-start must stop as soon as shutdown begins")
            .unwrap();
        assert!(!ran.load(Ordering::SeqCst));
    }
    async fn recorded_automation() -> (AppHandle, String) {
        use crate::utils::types::automation::{Automation, AutomationArgs};
        let app = app_with_state();
        let id = AutomationsCache::generate_automation_id(
            "Local",
            "drive",
            &OperationType::Mount,
            "work",
        );
        let args = AutomationArgs {
            source: Origin::Automation,
            src_paths: Vec::new(),
            dst_paths: Vec::new(),
        };
        let automation = Automation::new(
            id.clone(),
            Some(OperationType::Mount),
            "drive".into(),
            "work".into(),
            args,
            "Local",
        );
        app.state::<AutomationsCache>()
            .add_automation(automation)
            .await
            .unwrap();
        (app, id)
    }

    async fn recorded(app: &AppHandle, id: &str) -> crate::utils::types::automation::Automation {
        app.state::<AutomationsCache>()
            .get_automation(id)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_start_that_is_done_once_it_runs_is_recorded_as_a_success() {
        use crate::utils::types::automation::AutomationStatus;
        let (app, id) = recorded_automation().await;

        run_recorded(&app, "Local", &id, |_| async { Ok(false) })
            .await
            .unwrap();

        let automation = recorded(&app, &id).await;
        assert_eq!(automation.status, AutomationStatus::Enabled);
        assert_eq!((automation.run_count, automation.success_count), (1, 1));
        assert!(automation.last_run.is_some() && automation.last_error.is_none());
    }

    #[tokio::test]
    async fn a_delayed_start_shows_when_it_is_due_until_the_wait_ends() {
        let (app, id) = recorded_automation().await;
        let handle = spawn_auto_start(&app, 3600, id.clone(), async {});
        let due = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(due) = recorded(&app, &id).await.auto_start_at {
                    break due;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("a delayed start must show when it is due");
        assert!(due > chrono::Utc::now() + chrono::TimeDelta::seconds(3590));
        app.state::<RcloneState>().set_shutting_down();
        handle.await.unwrap();

        assert_eq!(recorded(&app, &id).await.auto_start_at, None);
    }

    #[tokio::test]
    async fn a_start_without_a_delay_shows_no_due_time() {
        let (app, id) = recorded_automation().await;
        spawn_auto_start(&app, 0, id.clone(), async {})
            .await
            .unwrap();
        assert_eq!(recorded(&app, &id).await.auto_start_at, None);
    }

    #[tokio::test]
    async fn a_start_that_a_job_ends_stays_running_until_the_job_reports() {
        use crate::utils::types::automation::AutomationStatus;
        let (app, id) = recorded_automation().await;
        let seen = Arc::new(std::sync::Mutex::new(None));
        let seen_id = seen.clone();

        run_recorded(&app, "Local", &id, |execution_id| async move {
            *seen_id.lock().unwrap() = execution_id;
            Ok(true)
        })
        .await
        .unwrap();

        let automation = recorded(&app, &id).await;
        assert_eq!(automation.status, AutomationStatus::Running);
        assert_eq!(automation.execution_id, *seen.lock().unwrap());
    }

    #[tokio::test]
    async fn a_failed_start_keeps_its_error_on_the_automation() {
        use crate::utils::types::automation::AutomationStatus;
        let (app, id) = recorded_automation().await;

        let result = run_recorded(&app, "Local", &id, |_| async {
            Err::<bool, _>("mount point is busy".to_string())
        })
        .await;

        assert_eq!(result.unwrap_err(), "mount point is busy");
        let automation = recorded(&app, &id).await;
        assert_eq!(automation.status, AutomationStatus::Failed);
        assert_eq!(
            automation.last_error.as_deref(),
            Some("mount point is busy")
        );
        assert_eq!(automation.failure_count, 1);
    }

    #[tokio::test]
    async fn a_start_the_user_stopped_is_recorded_as_stopped() {
        use crate::utils::types::automation::AutomationStatus;
        let (app, id) = recorded_automation().await;

        let result = run_recorded(&app, "Local", &id, |_| async {
            Err::<bool, _>(crate::localized_error!("backendErrors.job.stopped"))
        })
        .await;

        assert!(result.is_err());
        let automation = recorded(&app, &id).await;
        assert_eq!(automation.status, AutomationStatus::Enabled);
        assert_eq!((automation.stopped_count, automation.failure_count), (1, 0));
        assert!(automation.last_error.is_none());
    }

    #[tokio::test]
    async fn a_start_that_is_already_running_is_not_repeated() {
        let (app, id) = recorded_automation().await;
        let ran = Arc::new(AtomicBool::new(false));
        run_recorded(&app, "Local", &id, |_| async { Ok(true) })
            .await
            .unwrap();

        let again = ran.clone();
        run_recorded(&app, "Local", &id, |_| async move {
            again.store(true, Ordering::SeqCst);
            Ok(false)
        })
        .await
        .unwrap();

        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(recorded(&app, &id).await.run_count, 1);
    }

    #[tokio::test]
    async fn a_start_runs_unrecorded_when_its_automation_is_missing() {
        let app = app_with_state();
        let seen = Arc::new(std::sync::Mutex::new(Some(String::new())));
        let seen_id = seen.clone();

        run_recorded(&app, "Local", "missing", |execution_id| async move {
            *seen_id.lock().unwrap() = execution_id;
            Ok(true)
        })
        .await
        .unwrap();

        assert_eq!(*seen.lock().unwrap(), None);
    }

    #[tokio::test]
    async fn a_turned_off_automation_does_not_start_with_the_app() {
        use crate::utils::types::automation::AutomationStatus;
        let (app, id) = recorded_automation().await;
        app.state::<AutomationsCache>()
            .update_automation(&id, |automation| {
                automation.status = AutomationStatus::Disabled;
            })
            .await
            .unwrap();
        let ran = Arc::new(AtomicBool::new(false));
        let again = ran.clone();

        run_recorded(&app, "Local", &id, |_| async move {
            again.store(true, Ordering::SeqCst);
            Ok(false)
        })
        .await
        .unwrap();

        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(recorded(&app, &id).await.status, AutomationStatus::Disabled);
    }

    #[tokio::test]
    async fn the_work_a_start_runs_announces_itself() {
        let (app, id) = recorded_automation().await;

        run_recorded(&app, "Local", &id, |_| async { Ok(true) })
            .await
            .unwrap();

        assert!(!recorded(&app, &id).await.announced);
    }
}
