use crate::context::AppHandle;
#[cfg(autostart_portal)]
use crate::utils::spawn;
use log::debug;
#[cfg(autostart_plugin)]
use tauri_plugin_autostart::ManagerExt;

#[cfg(autostart_portal)]
pub async fn manage_flatpak_background_portal(enable: bool) -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::Variant;
    use zbus::{Connection, Proxy};

    let connection = Connection::session().await.map_err(|e| e.to_string())?;

    // Proxy to the Desktop portal Background interface
    let proxy = Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Background",
    )
    .await
    .map_err(|e| e.to_string())?;

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
    let path = proxy
        .call::<_, _, zbus::OwnedObjectPath>("RequestBackground", &("", &options))
        .await
        .map_err(|e| e.to_string())?;
    log::debug!(
        "Background portal request sent successfully. Request path: {}",
        path.as_str()
    );
    Ok(())
}

#[cfg(autostart_portal)]
pub(crate) fn handle_autostart_change(_app: &AppHandle, enabled: bool) {
    debug!("Autostart changed to: {enabled}");
    spawn(async move {
        if let Err(e) = crate::desktop::autostart::manage_flatpak_background_portal(enabled).await {
            log::error!("Failed to update flatpak autostart: {e}");
        }
    });
}

#[cfg(autostart_plugin)]
pub(crate) fn handle_autostart_change(app: &AppHandle, enabled: bool) {
    debug!("Autostart changed to: {enabled}");
    let autostart = app.autolaunch();
    let result = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    if let Err(e) = result {
        log::error!(
            "Failed to {} autostart: {e}",
            if enabled { "enable" } else { "disable" }
        );
    }
}

/// Re-create the OS autostart entry if it was removed while the setting is still on.
#[cfg(autostart_plugin)]
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
