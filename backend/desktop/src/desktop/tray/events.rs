use crate::context::AppHandle;
use crate::context::BackendContext;
#[cfg(not(feature = "web-server"))]
use crate::desktop::tray::actions::handle_browse_remote;
use crate::desktop::tray::{
    actions::{
        handle_mount_profile, handle_serve_profile, handle_start_job_profile,
        handle_start_quick_run, handle_start_workflow, handle_stop_all_jobs,
        handle_stop_job_profile, handle_stop_quick_run, handle_stop_serve_profile,
        handle_stop_workflow, handle_unmount_profile,
    },
    tray_action::TrayAction,
};
use crate::utils::spawn;
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
    use crate::utils::types::remotes::OperationType;

    #[cfg(feature = "web-server")]
    use tauri_plugin_opener::OpenerExt;

    if crate::services::settings::access::is_locked(app.backend()) && !action.allowed_when_locked()
    {
        return;
    }
    match action {
        TrayAction::StartProfile(op, remote, profile) => match op {
            OperationType::Mount => {
                handle_mount_profile(app.clone(), &remote, &profile);
            }
            OperationType::Serve => {
                handle_serve_profile(app.clone(), &remote, &profile);
            }
            op if op.is_transfer() => {
                handle_start_job_profile(app.clone(), &remote, &profile, op);
            }
            _ => {}
        },
        TrayAction::StopProfile(op, remote, profile) => match op {
            OperationType::Mount => {
                handle_unmount_profile(app.clone(), &remote, &profile);
            }
            OperationType::Serve => {
                handle_stop_serve_profile(app.clone(), &profile);
            }
            op if op.is_transfer() => {
                if let Some(job_type) = op.as_job_type() {
                    handle_stop_job_profile(app.clone(), &remote, &profile, job_type);
                }
            }
            _ => {}
        },
        TrayAction::StartQuickRun(id) => {
            handle_start_quick_run(app.clone(), id);
        }
        TrayAction::StopQuickRun(id) => {
            handle_stop_quick_run(app.clone(), id);
        }
        TrayAction::StartWorkflow(id) => {
            handle_start_workflow(app.clone(), id);
        }
        TrayAction::StopWorkflow(id) => {
            handle_stop_workflow(app.clone(), id);
        }
        TrayAction::Browse(_remote, _profile) => {
            #[cfg(not(feature = "web-server"))]
            handle_browse_remote(app, &_remote, &_profile);
        }
        TrayAction::BrowseInApp(remote) => {
            #[cfg(not(feature = "web-server"))]
            crate::desktop::tray::actions::handle_browse_in_app(app, Some(&remote));

            #[cfg(feature = "web-server")]
            {
                let url = web_ui_url(app, &format!("/nautilus/{}", urlencoding::encode(&remote)));
                if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                    log::error!("Failed to open web UI for browsing: {e}");
                }
            }
        }
        TrayAction::UnmountAll => {
            let app_clone = app.clone();
            crate::utils::spawn(async move {
                if let Err(e) = crate::rclone::commands::mount::unmount_all_remotes(
                    app_clone.backend().clone(),
                    crate::rclone::commands::common::OperationContext::Normal,
                )
                .await
                {
                    log::error!("Failed to unmount all remotes: {e}");
                }
            });
        }
        TrayAction::StopAllJobs => handle_stop_all_jobs(app.clone()),
        TrayAction::StopAllServes => {
            let app_clone = app.clone();
            crate::utils::spawn(async move {
                if let Err(e) = crate::rclone::commands::serve::stop_all_serves(
                    app_clone.backend().clone(),
                    crate::rclone::commands::common::OperationContext::Normal,
                )
                .await
                {
                    log::error!("Failed to stop all serves: {e}");
                }
            });
        }
        TrayAction::OpenFileBrowser => {
            #[cfg(not(feature = "web-server"))]
            crate::desktop::tray::actions::handle_browse_in_app(app, None);

            #[cfg(feature = "web-server")]
            {
                let url = web_ui_url(app, "/nautilus");
                if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                    log::error!("Failed to open web UI for file browser: {e}");
                }
            }
        }
        TrayAction::ShowApp => {
            #[cfg(not(feature = "web-server"))]
            crate::desktop::tray::actions::show_main_window(app.clone());
        }
        TrayAction::OpenWebUI => {
            #[cfg(feature = "web-server")]
            {
                let url = web_ui_url(app, "");
                if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                    log::error!("Failed to open web UI: {e}");
                }
            }
        }
        TrayAction::Quit => {
            let app_clone = app.clone();
            crate::utils::spawn(async move {
                let _ =
                    crate::services::lifecycle::exit::request_app_exit(app_clone.backend().clone())
                        .await;
            });
        }
    }
}

#[cfg(feature = "web-server")]
fn web_ui_url(app: &crate::context::AppHandle, path: &str) -> String {
    use tauri::Manager;
    let args = app.state::<crate::cli::CliArgs>();
    args.headless.web_ui_url(path)
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
