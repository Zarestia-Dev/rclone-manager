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

/// Runs an auto-start on its own task once its delay has passed. The run is skipped
/// when the app began shutting down in the meantime.
pub(crate) fn spawn_auto_start<F>(
    app: &AppHandle,
    delay_secs: u64,
    run: F,
) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let app = app.clone();
    crate::utils::spawn(async move {
        let still_running = app
            .state::<crate::utils::types::state::RcloneState>()
            .sleep_unless_shutdown(Duration::from_secs(delay_secs))
            .await;
        if still_running {
            run.await;
        }
    })
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
        let handle = spawn_auto_start(app, delay, async move {
            let app = task_app;
            let remote = params.remote_name.clone();
            let profile = params.profile_name.clone();
            let result = match operation {
                OperationType::Mount => mount_remote_profile(app, params).await,
                OperationType::Serve => start_serve_profile(app, params).await.map(|_| ()),
                transfer => start_profile_batch(app, transfer, params).await.map(|_| ()),
            };
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

        spawn_auto_start(&app, 0, mark(&ran)).await.unwrap();

        assert!(ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn is_skipped_when_shutdown_already_began() {
        let app = app_with_state();
        app.state::<RcloneState>().set_shutting_down();
        let ran = Arc::new(AtomicBool::new(false));

        spawn_auto_start(&app, 0, mark(&ran)).await.unwrap();

        assert!(!ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn shutdown_during_the_delay_ends_the_wait_without_running() {
        let app = app_with_state();
        let ran = Arc::new(AtomicBool::new(false));
        let handle = spawn_auto_start(&app, 3600, mark(&ran));

        tokio::time::sleep(Duration::from_millis(20)).await;
        app.state::<RcloneState>().set_shutting_down();

        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("a delayed auto-start must stop as soon as shutdown begins")
            .unwrap();
        assert!(!ran.load(Ordering::SeqCst));
    }
}
