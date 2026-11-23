//! What a clicked tray entry does. Core work runs here; opening the interface or a
//! folder is up to the host.
use super::action::TrayAction;
use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::rclone::commands::{
    common::OperationContext,
    job::stop_job_profile,
    mount::{mount_remote_profile, unmount_all_remotes, unmount_remote_profile},
    serve::{start_serve_profile, stop_all_serves, stop_serve_profile},
    sync::start_profile_batch,
};
use crate::services::flow::{quick_run::commands as quick_run, workflow};
use crate::utils::spawn;
use crate::utils::{
    app::notification::{JobStage, NotificationEvent, notify},
    types::{
        jobs::JobType,
        origin::Origin,
        remotes::{OperationType, ProfileParams},
    },
};
use log::{error, info};
use std::fmt::Display;
use std::future::Future;

/// The part of the interface a tray entry opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayView<'a> {
    /// The main window, or the web UI's start page.
    Main,
    /// The file browser, at a remote's root when one is given.
    FileBrowser(Option<&'a str>),
}

/// Runs the tray entry with menu id `id`. Unknown ids are ignored.
pub fn handle_menu_id(app: &AppHandle, id: &str) {
    if let Some(action) = TrayAction::from_id(id) {
        dispatch(app, action);
    }
}

fn dispatch(app: &AppHandle, action: TrayAction) {
    if crate::services::settings::access::is_locked(app) && !action.allowed_when_locked() {
        return;
    }
    match action {
        TrayAction::StartProfile(op, remote, profile) => {
            let description = format!("start {op} for {remote} / {profile}");
            let params = profile_params(&remote, &profile);
            match op {
                OperationType::Mount => {
                    run_action(description, mount_remote_profile(app.clone(), params));
                }
                OperationType::Serve => {
                    run_action(description, start_serve_profile(app.clone(), params));
                }
                op if op.is_transfer() => {
                    run_action(description, start_profile_batch(app.clone(), op, params));
                }
                _ => {}
            }
        }
        TrayAction::StopProfile(op, remote, profile) => {
            let description = format!("stop {op} for {remote} / {profile}");
            match op {
                OperationType::Mount => run_action(
                    description,
                    unmount_remote_profile(app.clone(), remote, profile),
                ),
                OperationType::Serve => run_action(
                    description,
                    stop_serve_profile(app.clone(), remote, profile),
                ),
                op => {
                    if let Some(job_type) = op.as_job_type() {
                        stop_job_profile_from_tray(app, remote, profile, job_type);
                    }
                }
            }
        }
        TrayAction::StartQuickRun(id) => run_action(
            format!("start quick run {id}"),
            quick_run::start_quick_run(app.clone(), id),
        ),
        TrayAction::StopQuickRun(id) => run_action(
            format!("stop quick run {id}"),
            quick_run::stop_quick_run(app.clone(), id, None),
        ),
        TrayAction::StartWorkflow(id) => run_action(
            format!("start workflow {id}"),
            workflow::commands::execute_workflow(app.clone(), id, None),
        ),
        TrayAction::StopWorkflow(id) => {
            let app = app.clone();
            run_action(format!("stop workflow {id}"), async move {
                workflow::engine::stop_workflow(&app, &id).await
            });
        }
        TrayAction::Browse(remote, profile) => browse_mount(app, remote, profile),
        TrayAction::BrowseInApp(remote) => {
            app.host().open_view(TrayView::FileBrowser(Some(&remote)));
        }
        TrayAction::UnmountAll => run_action(
            "unmount all remotes".to_string(),
            unmount_all_remotes(app.clone(), OperationContext::Normal),
        ),
        TrayAction::StopAllJobs => {
            spawn(
                crate::services::lifecycle::shutdown::stop_all_active_jobs_with_notice(app.clone()),
            );
        }
        TrayAction::StopAllServes => run_action(
            "stop all serves".to_string(),
            stop_all_serves(app.clone(), OperationContext::Normal),
        ),
        TrayAction::OpenFileBrowser => app.host().open_view(TrayView::FileBrowser(None)),
        TrayAction::ShowApp => app.host().open_view(TrayView::Main),
        TrayAction::Quit => {
            let app = app.clone();
            spawn(async move {
                let _ = crate::services::lifecycle::exit::request_app_exit(app).await;
            });
        }
    }
}

fn profile_params(remote_name: &str, profile_name: &str) -> ProfileParams {
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
fn run_action<T, E>(description: String, task: impl Future<Output = Result<T, E>> + Send + 'static)
where
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
fn stop_job_profile_from_tray(app: &AppHandle, remote: String, profile: String, job_type: JobType) {
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

/// Opens a mounted profile's mount point in the file manager.
fn browse_mount(app: &AppHandle, remote: String, profile: String) {
    let app = app.clone();
    spawn(async move {
        let mount = app
            .state::<BackendManager>()
            .remote_cache()
            .await
            .find_mount_by_profile(&remote, &profile)
            .await;
        let Some(mount) = mount else {
            error!("Tray: {remote} / {profile} is not mounted, nothing to browse");
            return;
        };
        match app
            .host()
            .open_folder(std::path::Path::new(&mount.mount_point))
        {
            Ok(()) => info!("Tray: opened file manager for {remote} / {profile}"),
            Err(e) => error!("Tray: failed to open file manager for {remote} / {profile}: {e}"),
        }
    });
}
