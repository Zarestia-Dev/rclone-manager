#[cfg(not(feature = "web-server"))]
use crate::context::BackendContext;
use log::{error, info};
use rclone_manager_core::context::AppHandle as CoreHandle;
use std::fmt::Display;
use std::future::Future;
#[cfg(not(feature = "web-server"))]
use tauri::AppHandle;

use crate::rclone::{backend::BackendManager, commands::job::stop_job_profile};
use crate::utils::spawn;
use crate::utils::{
    app::notification::{JobStage, NotificationEvent, notify},
    types::{jobs::JobType, origin::Origin, remotes::ProfileParams},
};

pub(crate) fn profile_params(remote_name: &str, profile_name: &str) -> ProfileParams {
    ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
        backend_name: None,
        source: Some(Origin::Dashboard),
        no_cache: None,
        scoped_targets: None,
        execute_id: None,
    }
}

/// Runs a tray-triggered backend call off the menu thread and logs how it ended.
pub(crate) fn run_action<T, E>(
    description: String,
    task: impl Future<Output = Result<T, E>> + Send + 'static,
) where
    T: Send + 'static,
    E: Display + Send + 'static,
{
    spawn(async move {
        match task.await {
            Ok(_) => info!("Tray: {description}"),
            Err(e) => error!("Tray: failed to {description}: {e}"),
        }
    });
}

/// Stops a profile's running job. The tray has no other way to say it failed, so a failure
/// also becomes a notification.
pub fn stop_job_profile_from_tray(
    app: &CoreHandle,
    remote: String,
    profile: String,
    job_type: JobType,
) {
    let app = app.clone();
    spawn(async move {
        let stopped = stop_job_profile(
            app.clone(),
            remote.clone(),
            profile.clone(),
            job_type.clone(),
        )
        .await;
        match stopped {
            Ok(()) => info!("Tray: stopped {job_type} job for {remote} / {profile}"),
            Err(error) => {
                error!("Tray: failed to stop {job_type} job for {remote} / {profile}: {error}");
                notify(
                    &app,
                    NotificationEvent::Job(JobStage::Failed {
                        backend: app.state::<BackendManager>().get_active_name().await,
                        remote,
                        profile: Some(profile),
                        job_type,
                        error,
                        origin: Origin::Dashboard,
                        source: None,
                        destination: None,
                    }),
                );
            }
        }
    });
}

#[cfg(not(feature = "web-server"))]
pub fn handle_browse_remote(app: &AppHandle, remote_name: &str, profile_name: &str) {
    use tauri_plugin_opener::OpenerExt;
    let (app, remote, profile) = (
        app.clone(),
        remote_name.to_string(),
        profile_name.to_string(),
    );

    spawn(async move {
        let mount = app
            .backend_state::<BackendManager>()
            .remote_cache()
            .await
            .find_mount_by_profile(&remote, &profile)
            .await;
        let Some(mount) = mount else {
            error!("Tray: {remote} / {profile} is not mounted, nothing to browse");
            return;
        };
        match app.opener().open_path(mount.mount_point, None::<&str>) {
            Ok(()) => info!("Tray: opened file manager for {remote} / {profile}"),
            Err(e) => error!("Tray: failed to open file manager for {remote} / {profile}: {e}"),
        }
    });
}

#[cfg(not(feature = "web-server"))]
pub fn handle_browse_in_app(app: &AppHandle, remote_name: Option<&str>) {
    info!("Tray: opening in-app browser for {remote_name:?}");
    let (app, options) = (
        app.clone(),
        crate::desktop::window::nautilus_window(remote_name),
    );
    spawn(async move {
        crate::desktop::window::new_window(app, options).await;
    });
}
