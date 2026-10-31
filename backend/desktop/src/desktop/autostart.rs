use crate::context::AppHandle;
#[cfg(all(target_os = "linux", feature = "flatpak"))]
use crate::utils::spawn;
use log::debug;
#[cfg(all(
    feature = "tauri-plugin-autostart",
    not(all(target_os = "linux", feature = "flatpak"))
))]
use tauri_plugin_autostart::ManagerExt;

#[cfg(all(target_os = "linux", feature = "flatpak"))]
pub async fn manage_flatpak_background_portal(enable: bool) -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::Variant;
    use zbus::{Connection, Proxy};

    // Attempt to connect to the session DBus
    let connection = match Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to connect to session bus: {e}");
            return Err(e.to_string());
        }
    };

    // Create a proxy to the Desktop portal Background interface
    let proxy = match Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Background",
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to create Background portal proxy: {e}");
            return Err(e.to_string());
        }
    };

    // Prepare the options dictionary (a{sv})
    let mut options: HashMap<&str, Variant> = HashMap::new();
    options.insert(
        "reason",
        Variant::from("RClone Manager needs to run in the background to handle scheduled jobs and serve remotes."),
    );
    options.insert("autostart", Variant::from(enable));
    options.insert("dbus-activatable", Variant::from(false));

    let autostart_cmd: zbus::Array = {
        use zbus::{Array, Signature};
        let sig = Signature::try_from("s").expect("valid sig");
        let mut arr = Array::new(&sig);
        for token in &[env!("CARGO_PKG_NAME"), "--tray"] {
            arr.append(Variant::from(*token))
                .expect("homogeneous string array");
        }
        arr
    };
    options.insert("commandline", Variant::from(autostart_cmd));

    // Call RequestBackground(parent_window: String, options: a{sv}) -> (ObjectPath)
    // We pass an empty string for parent_window since we don't track the X11/Wayland window ID here.
    match proxy
        .call::<_, _, zbus::OwnedObjectPath>("RequestBackground", &("", &options))
        .await
    {
        Ok(path) => {
            log::debug!(
                "Background portal request sent successfully. Request path: {}",
                path.as_str()
            );
            Ok(())
        }
        Err(e) => {
            log::error!("Background portal request failed: {e}");
            Err(e.to_string())
        }
    }
}

#[cfg(all(target_os = "linux", feature = "flatpak"))]
pub(crate) fn handle_autostart_change(_app: &AppHandle, enabled: bool) {
    debug!("Autostart changed to: {enabled}");
    spawn(async move {
        if let Err(e) = crate::desktop::autostart::manage_flatpak_background_portal(enabled).await {
            log::error!("Failed to update flatpak autostart: {e}");
        }
    });
}

#[cfg(all(
    feature = "tauri-plugin-autostart",
    not(all(target_os = "linux", feature = "flatpak"))
))]
pub(crate) fn handle_autostart_change(app: &AppHandle, enabled: bool) {
    debug!("Autostart changed to: {enabled}");
    let autostart = app.autolaunch();
    let _ = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
}

/// Re-create the OS autostart entry if it was removed while the setting is still on.
#[cfg(all(
    feature = "tauri-plugin-autostart",
    not(all(target_os = "linux", feature = "flatpak"))
))]
pub(crate) fn restore_missing_autostart(app: &AppHandle) {
    // A development binary must not register itself to launch at login.
    if cfg!(debug_assertions) {
        return;
    }
    let autostart = app.autolaunch();
    match autostart.is_enabled() {
        Ok(true) => {}
        Ok(false) => {
            debug!("Autostart entry is missing, restoring it");
            if let Err(e) = autostart.enable() {
                log::error!("Failed to restore autostart entry: {e}");
            }
        }
        Err(e) => log::error!("Failed to check autostart entry: {e}"),
    }
}
