use crate::context::BackendContext;
use crate::{context::Manager, services};
use tauri::WindowEvent;

pub(super) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.on_window_event(|window, event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let app_handle = window.app_handle();

            let destroy_on_close = app_handle
                .backend_try_state::<services::settings::AppSettingsManager>()
                .and_then(|manager| {
                    manager
                        .get_all()
                        .ok()
                        .map(|s| s.developer.destroy_window_on_close)
                })
                .unwrap_or(false);

            if window.label() == "main" {
                if has_visible_tray(app_handle.backend()) {
                    if destroy_on_close {
                        log::debug!("Optimization Enabled: Destroying window to free RAM");
                    } else {
                        if let Err(e) = window.hide() {
                            log::error!("Failed to hide window: {e}");
                        }
                        api.prevent_close();
                    }
                    #[cfg(target_os = "macos")]
                    crate::native::dock::update_macos_dock_visibility(app_handle);
                } else {
                    api.prevent_close();
                    let app_handle_clone = app_handle.clone();
                    crate::utils::spawn(async move {
                        let _ = crate::services::lifecycle::exit::request_app_exit(
                            app_handle_clone.backend().clone(),
                        )
                        .await;
                    });
                }
            }
        }
        WindowEvent::Destroyed => {
            #[cfg(target_os = "macos")]
            crate::native::dock::update_macos_dock_visibility(window.app_handle());
        }
        WindowEvent::Focused(true) => {
            #[cfg(target_os = "macos")]
            crate::native::dock::update_macos_dock_visibility(window.app_handle());
        }
        _ => {}
    })
}

/// Whether closing the window can leave the app reachable in the background.
/// Builds without a tray (or with the tray hidden or failed) must exit instead.
fn has_visible_tray(app: &rclone_manager_core::context::AppHandle) -> bool {
    #[cfg(feature = "tray")]
    return app
        .try_state::<crate::desktop::tray::TrayMenuState>()
        .is_some_and(|state| state.visible.load(std::sync::atomic::Ordering::SeqCst));
    #[cfg(not(feature = "tray"))]
    {
        let _ = app;
        false
    }
}

/// Whether startup shows the main window.
///
/// `--tray` (autostart) starts hidden, except while the vault is locked: initialization
/// is postponed until it is unlocked, so neither the tray nor any other window exists,
/// and the window is the only place to enter the password.
pub(super) fn should_open_main_window(args: &crate::cli::CliArgs, vault_locked: bool) -> bool {
    let hidden_start = args.start_in_tray() && !vault_locked;
    !hidden_start && args.general.send_to_remote.is_none()
}

#[cfg(test)]
mod tests {
    use super::{has_visible_tray, should_open_main_window};
    use crate::cli::CliArgs;
    use clap::Parser;

    #[test]
    fn closing_without_a_tray_cannot_leave_an_unreachable_background_app() {
        assert!(!has_visible_tray(&Default::default()));
    }

    #[cfg(feature = "tray")]
    #[test]
    fn visible_tray_keeps_the_app_running_when_settings_are_unavailable() {
        use crate::desktop::tray::TrayMenuState;
        use std::sync::atomic::Ordering;

        // Vault-protected settings must not be needed for this native decision.
        let app = rclone_manager_core::context::AppHandle::default();
        app.manage(TrayMenuState::default());
        let tray = app.state::<TrayMenuState>();
        // Failed/absent setup and a hidden tray must not trap a background app.
        assert!(!has_visible_tray(&app));
        tray.requested_visible.store(true, Ordering::SeqCst);
        assert!(!has_visible_tray(&app));
        tray.visible.store(true, Ordering::SeqCst);
        assert!(has_visible_tray(&app));
        tray.visible.store(false, Ordering::SeqCst);
        assert!(!has_visible_tray(&app));
    }

    #[test]
    fn normal_desktop_startup_opens_its_window() {
        let args = CliArgs::try_parse_from(["app"]).unwrap();
        assert!(should_open_main_window(&args, false));
    }

    #[cfg(feature = "tray")]
    #[test]
    fn explicit_tray_startup_hides_the_window() {
        let args = CliArgs::try_parse_from(["app", "--tray"]).unwrap();
        assert!(!should_open_main_window(&args, false));
    }

    #[cfg(feature = "tray")]
    #[test]
    fn a_locked_vault_shows_the_window_even_for_a_hidden_start() {
        // Initialization waits for the unlock, so no tray exists to open it from.
        let args = CliArgs::try_parse_from(["app", "--tray"]).unwrap();
        assert!(should_open_main_window(&args, true));
    }

    #[cfg(not(feature = "tray"))]
    #[test]
    fn builds_without_tray_reject_the_tray_argument() {
        assert!(CliArgs::try_parse_from(["app", "--tray"]).is_err());
    }

    #[test]
    fn send_to_does_not_open_a_window() {
        let args = CliArgs::try_parse_from(["app", "--send-to-remote", "remote"]).unwrap();
        assert!(!should_open_main_window(&args, false));
        assert!(!should_open_main_window(&args, true));
    }
}
