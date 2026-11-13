use crate::context::AppHandle;
use crate::context::BackendContext;
#[cfg(not(feature = "web-server"))]
use crate::desktop::tray::actions::{handle_browse_in_app, handle_browse_remote};
use crate::desktop::tray::{
    actions::{profile_params, run_action, stop_job_profile_from_tray},
    tray_action::TrayAction,
};
use crate::rclone::commands::{
    common::OperationContext,
    mount::{mount_remote_profile, unmount_all_remotes, unmount_remote_profile},
    serve::{start_serve_profile, stop_all_serves, stop_serve_profile},
    sync::start_profile_batch,
};
use crate::services::flow::{quick_run::commands as quick_run, workflow};
use crate::utils::spawn;
use crate::utils::types::remotes::OperationType;
use log::{debug, error};

pub(crate) fn handle_tray_menu_event(
    app: &crate::context::AppHandle,
    event: &tauri::menu::MenuEvent,
) {
    if let Some(action) = TrayAction::from_id(event.id.as_ref()) {
        dispatch_tray_action(app, action);
    }
}

fn dispatch_tray_action(app: &crate::context::AppHandle, action: TrayAction) {
    let core = app.backend();
    if crate::services::settings::access::is_locked(core) && !action.allowed_when_locked() {
        return;
    }
    match action {
        TrayAction::StartProfile(op, remote, profile) => {
            let description = format!("start {op} for {remote} / {profile}");
            let params = profile_params(&remote, &profile);
            match op {
                OperationType::Mount => {
                    run_action(description, mount_remote_profile(core.clone(), params));
                }
                OperationType::Serve => {
                    run_action(description, start_serve_profile(core.clone(), params));
                }
                op if op.is_transfer() => {
                    run_action(description, start_profile_batch(core.clone(), op, params));
                }
                _ => {}
            }
        }
        TrayAction::StopProfile(op, remote, profile) => {
            let description = format!("stop {op} for {remote} / {profile}");
            match op {
                OperationType::Mount => run_action(
                    description,
                    unmount_remote_profile(core.clone(), remote, profile),
                ),
                OperationType::Serve => run_action(
                    description,
                    stop_serve_profile(core.clone(), remote, profile),
                ),
                op => {
                    if let Some(job_type) = op.as_job_type() {
                        stop_job_profile_from_tray(core, remote, profile, job_type);
                    }
                }
            }
        }
        TrayAction::StartQuickRun(id) => run_action(
            format!("start quick run {id}"),
            quick_run::start_quick_run(core.clone(), id),
        ),
        TrayAction::StopQuickRun(id) => run_action(
            format!("stop quick run {id}"),
            quick_run::stop_quick_run(core.clone(), id, None),
        ),
        TrayAction::StartWorkflow(id) => run_action(
            format!("start workflow {id}"),
            workflow::commands::execute_workflow(core.clone(), id, None),
        ),
        TrayAction::StopWorkflow(id) => {
            let core = core.clone();
            run_action(format!("stop workflow {id}"), async move {
                workflow::engine::stop_workflow(&core, &id).await
            });
        }
        TrayAction::Browse(_remote, _profile) => {
            #[cfg(not(feature = "web-server"))]
            handle_browse_remote(app, &_remote, &_profile);
        }
        TrayAction::BrowseInApp(remote) => {
            #[cfg(not(feature = "web-server"))]
            handle_browse_in_app(app, Some(&remote));
            #[cfg(feature = "web-server")]
            open_web_ui(app, &format!("/nautilus/{}", urlencoding::encode(&remote)));
        }
        TrayAction::UnmountAll => run_action(
            "unmount all remotes".to_string(),
            unmount_all_remotes(core.clone(), OperationContext::Normal),
        ),
        TrayAction::StopAllJobs => {
            spawn(
                crate::services::lifecycle::shutdown::stop_all_active_jobs_with_notice(
                    core.clone(),
                ),
            );
        }
        TrayAction::StopAllServes => run_action(
            "stop all serves".to_string(),
            stop_all_serves(core.clone(), OperationContext::Normal),
        ),
        TrayAction::OpenFileBrowser => {
            #[cfg(not(feature = "web-server"))]
            handle_browse_in_app(app, None);
            #[cfg(feature = "web-server")]
            open_web_ui(app, "/nautilus");
        }
        TrayAction::ShowApp => {
            #[cfg(not(feature = "web-server"))]
            crate::desktop::window::present_main_window(app);
        }
        TrayAction::OpenWebUI => {
            #[cfg(feature = "web-server")]
            open_web_ui(app, "");
        }
        TrayAction::Quit => {
            let core = core.clone();
            spawn(async move {
                let _ = crate::services::lifecycle::exit::request_app_exit(core).await;
            });
        }
    }
}

#[cfg(feature = "web-server")]
fn open_web_ui(app: &crate::context::AppHandle, path: &str) {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let url = app.state::<crate::cli::CliArgs>().headless.web_ui_url(path);
    if let Err(e) = app.opener().open_url(&url, None::<&str>) {
        error!("Failed to open web UI ({path}): {e}");
    }
}

pub(crate) fn trigger_tray_update(app: AppHandle) {
    spawn(async move {
        if let Err(e) = crate::desktop::tray::core::update_tray_menu(app).await {
            error!("Failed to update tray menu: {e}");
        }
    });
}

pub(crate) fn handle_tray_visibility_change(app: &AppHandle, enabled: bool) {
    use std::sync::atomic::Ordering;

    let state = app.backend_state::<crate::desktop::tray::TrayMenuState>();
    state.requested_visible.store(enabled, Ordering::SeqCst);
    debug!("Tray visibility changed to: {enabled}");
    if let Some(tray) = app.tray_by_id("main-tray") {
        match tray.set_visible(enabled) {
            Ok(()) => state.visible.store(enabled, Ordering::SeqCst),
            Err(error) => error!("Failed to change tray visibility: {error}"),
        }
    } else if enabled {
        let app = app.clone();
        spawn(async move {
            if let Err(error) = crate::desktop::tray::setup::setup_tray(app).await {
                error!("Failed to set up tray: {error}");
            }
        });
    }
}
