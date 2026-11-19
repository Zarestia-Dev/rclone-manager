use crate::context::BackendContext;
use crate::{context::Manager, services};
use tauri::WindowEvent;

pub(super) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.on_window_event(|window, event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let app_handle = window.app_handle();

            let destroy_on_close = app_handle
                .backend()
                .try_state::<services::settings::AppSettingsManager>()
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

/// The desktop's title bar button layout in GTK's `gtk-decoration-layout` form, such as
/// `appmenu:close` or `close,minimize,maximize:`. GNOME sets it from its `button-layout`
/// setting and KDE from its window decoration settings. Only Linux has one. The first call
/// also starts following changes, which arrive as `WINDOW_BUTTON_LAYOUT_CHANGED`.
#[tauri::command]
pub async fn get_window_button_layout(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        #[cfg(feature = "desktop")]
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            static WATCHING: AtomicBool = AtomicBool::new(false);
            if !WATCHING.swap(true, Ordering::SeqCst) {
                crate::utils::spawn(watch_button_layout());
            }
        }

        // GTK settings may only be read on the main thread.
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            use gtk::prelude::GtkSettingsExt;
            let layout = gtk::Settings::default()
                .and_then(|settings| settings.gtk_decoration_layout())
                .map(|layout| layout.to_string());
            let _ = tx.send(layout);
        })
        .ok()?;
        rx.await.ok().flatten()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        None
    }
}

/// Follows the button layout through the XDG settings portal, like the theme watcher, and
/// emits each new value. GTK 3 does notify when the setting changes, but on Wayland its
/// `gtk-decoration-layout` keeps the old value, so it cannot tell what changed.
#[cfg(all(feature = "desktop", target_os = "linux"))]
async fn watch_button_layout() {
    use futures::StreamExt;

    let Some(changes) =
        super::portal::setting_changes("org.gnome.desktop.wm.preferences", "button-layout").await
    else {
        return;
    };
    let mut changes = std::pin::pin!(changes);
    // GNOME's portal sends every change twice.
    let mut last = None;
    while let Some(message) = changes.next().await {
        let Some(value) = super::portal::changed_value(&message) else {
            continue;
        };
        let layout = portal_string(&value);
        if last.as_ref() == Some(&layout) {
            continue;
        }
        last = Some(layout.clone());
        crate::services::bridge::emit(
            crate::utils::types::events::WINDOW_BUTTON_LAYOUT_CHANGED,
            layout,
        );
    }
}

/// The string in a portal setting value, which some portals wrap in a second variant.
#[cfg(all(feature = "desktop", target_os = "linux"))]
fn portal_string(value: &zbus::Variant) -> Option<String> {
    match value {
        zbus::Variant::Str(text) => Some(text.to_string()),
        zbus::Variant::Variant(inner) => portal_string(inner),
        _ => None,
    }
}

/// The system accent colour as `#rrggbb` (Linux, Windows and macOS), or `None` when the
/// system has none. The first call also starts following changes, which arrive as
/// `SYSTEM_ACCENT_COLOR_CHANGED`.
#[tauri::command]
pub async fn get_system_accent_color() -> Option<String> {
    #[cfg(all(
        feature = "desktop",
        any(target_os = "linux", windows, target_os = "macos")
    ))]
    {
        super::accent::accent_color().await
    }
    #[cfg(not(all(
        feature = "desktop",
        any(target_os = "linux", windows, target_os = "macos")
    )))]
    None
}

#[cfg(test)]
mod tests {
    #[cfg(all(feature = "desktop", target_os = "linux"))]
    #[test]
    fn portal_string_reads_plain_and_wrapped_layouts() {
        use super::portal_string;
        let plain = zbus::Variant::from("appmenu:close");
        assert_eq!(portal_string(&plain), Some("appmenu:close".to_string()));
        let wrapped =
            zbus::Variant::Variant(Box::new(zbus::Variant::from("close,minimize,maximize:")));
        assert_eq!(
            portal_string(&wrapped),
            Some("close,minimize,maximize:".to_string())
        );
        assert_eq!(portal_string(&zbus::Variant::from(1u32)), None);
    }

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
