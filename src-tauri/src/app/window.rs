#[cfg(desktop)]
use crate::{core, utils::context::Manager};
use tauri::WindowEvent;

pub(super) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.on_window_event(|_window, event| match event {
        #[cfg(desktop)]
        WindowEvent::CloseRequested { api, .. } => {
            let app_handle = _window.app_handle();

            let destroy_on_close = app_handle
                .try_state::<core::settings::AppSettingsManager>()
                .and_then(|manager| {
                    manager
                        .get_all()
                        .ok()
                        .map(|s| s.developer.destroy_window_on_close)
                })
                .unwrap_or(false);

            #[cfg(feature = "tray")]
            let tray_enabled = app_handle
                .try_state::<core::settings::AppSettingsManager>()
                .and_then(|manager| manager.get_all().ok().map(|s| s.general.tray_enabled))
                .unwrap_or(false);

            #[cfg(not(feature = "tray"))]
            let tray_enabled = false;

            if _window.label() == "main" {
                if tray_enabled {
                    if destroy_on_close {
                        log::debug!("Optimization Enabled: Destroying window to free RAM");
                    } else {
                        if let Err(e) = _window.hide() {
                            log::error!("Failed to hide window: {e}");
                        }
                        api.prevent_close();
                    }
                    #[cfg(target_os = "macos")]
                    crate::utils::app::platform::update_macos_dock_visibility(app_handle);
                } else {
                    api.prevent_close();
                    let app_handle_clone = app_handle.clone();
                    crate::utils::spawn(async move {
                        let _ =
                            crate::utils::app::platform::request_app_exit(app_handle_clone).await;
                    });
                }
            }
        }
        WindowEvent::Destroyed => {
            #[cfg(target_os = "macos")]
            crate::utils::app::platform::update_macos_dock_visibility(_window.app_handle());
        }
        #[cfg(desktop)]
        WindowEvent::Focused(true) => {
            #[cfg(target_os = "macos")]
            crate::utils::app::platform::update_macos_dock_visibility(_window.app_handle());
        }
        _ => {}
    })
}

#[cfg(desktop)]
pub(super) fn should_open_main_window(args: &crate::core::cli::GeneralArgs) -> bool {
    #[cfg(feature = "tray")]
    if args.tray {
        return false;
    }
    args.send_to_remote.is_none()
}

#[cfg(all(test, desktop))]
mod tests {
    use super::should_open_main_window;
    use crate::core::cli::CliArgs;
    use clap::Parser;

    #[test]
    fn normal_desktop_startup_opens_its_window() {
        let args = CliArgs::try_parse_from(["app"]).unwrap();
        assert!(should_open_main_window(&args.general));
    }

    #[cfg(feature = "tray")]
    #[test]
    fn explicit_tray_startup_hides_the_window() {
        let args = CliArgs::try_parse_from(["app", "--tray"]).unwrap();
        assert!(!should_open_main_window(&args.general));
    }

    #[cfg(not(feature = "tray"))]
    #[test]
    fn builds_without_tray_reject_the_tray_argument() {
        assert!(CliArgs::try_parse_from(["app", "--tray"]).is_err());
    }

    #[test]
    fn send_to_does_not_open_a_window() {
        let args = CliArgs::try_parse_from(["app", "--send-to-remote", "remote"]).unwrap();
        assert!(!should_open_main_window(&args.general));
    }
}
