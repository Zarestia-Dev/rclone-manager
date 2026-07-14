pub const APP_ID: &str = "io.github.zarestia_dev.rclone-manager";
pub const APP_ID_DEV: &str = "io.github.zarestia_dev.rclone-manager-dev";

#[tauri::command]
#[must_use]
pub fn get_build_type() -> Option<&'static str> {
    if cfg!(feature = "flatpak") {
        Some("flatpak")
    } else if cfg!(feature = "container") {
        Some("container")
    } else if cfg!(feature = "portable") {
        Some("portable")
    } else {
        None
    }
}

#[tauri::command]
#[must_use]
pub fn is_librclone() -> bool {
    cfg!(feature = "librclone")
}

#[tauri::command]
pub async fn relaunch_app(app: tauri::AppHandle) -> Result<(), String> {
    use crate::core::lifecycle::shutdown::handle_shutdown;
    handle_shutdown(app.clone()).await;
    app.restart();
}

#[cfg(all(target_os = "linux", feature = "flatpak"))]
pub async fn manage_flatpak_background_portal(enable: bool) -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::zvariant::Value;
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
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert(
        "reason",
        Value::from("RClone Manager needs to run in the background to handle scheduled jobs and serve remotes."),
    );
    options.insert("autostart", Value::from(enable));
    options.insert("dbus-activatable", Value::from(false));

    let autostart_cmd: zbus::zvariant::Array = {
        use zbus::zvariant::{Array, Signature};
        let sig = Signature::try_from("s").expect("valid sig");
        let mut arr = Array::new(&sig);
        for token in &[env!("CARGO_PKG_NAME"), "--tray"] {
            arr.append(Value::from(*token))
                .expect("homogeneous string array");
        }
        arr
    };
    options.insert("commandline", Value::from(autostart_cmd));

    // Call RequestBackground(parent_window: String, options: a{sv}) -> (ObjectPath)
    // We pass an empty string for parent_window since we don't track the X11/Wayland window ID here.
    match proxy
        .call::<_, _, zbus::zvariant::OwnedObjectPath>("RequestBackground", &("", &options))
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

// // This one uses ashpd, same as the one above but I left it here as a comment. Maybe it will be useful for someone later.
// #[cfg(feature = "flatpak")]
// pub async fn manage_flatpak_background_portal(enable: bool) -> Result<(), String> {
//     use ashpd::desktop::background::Background;

//     let bin_name = env!("CARGO_PKG_NAME");
//     let commandline = [bin_name, "--tray"];

//     match Background::request()
//         .reason("RClone Manager needs to run in the background to handle scheduled jobs and serve remotes.")
//         .auto_start(enable)
//         .command(&commandline)
//         .dbus_activatable(false)
//         .send()
//         .await
//     {
//         Ok(request) => match request.response() {
//             Ok(_) => {
//                 log::debug!("Background portal request successful (autostart={})", enable);
//                 Ok(())
//             }
//             Err(e) => {
//                 log::error!("Background portal request denied: {e}");
//                 Err(format!("Background portal request denied: {e}"))
//             }
//         }
//         Err(e) => {
//             log::error!("Could not communicate with Background portal: {e}");
//             Err(format!("Could not communicate with Background portal: {e}"))
//         }
//     }
// }

#[cfg(target_os = "macos")]
pub fn update_macos_dock_visibility(app_handle: &tauri::AppHandle) {
    use tauri::Manager;
    let has_visible_windows = app_handle
        .webview_windows()
        .values()
        .any(|w| w.is_visible().unwrap_or(false));

    let policy = if has_visible_windows {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };

    let _ = app_handle.set_activation_policy(policy);
}

#[tauri::command]
#[must_use]
pub fn is_updater_enabled() -> bool {
    cfg!(feature = "updater")
}
