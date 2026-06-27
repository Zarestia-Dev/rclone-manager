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

// This one uses ashpd, same as the one above but I left it here as a comment. Maybe it will be useful for someone later.
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

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn is_send_to_supported() -> bool {
    true
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn register_send_to(
    _app: tauri::AppHandle,
    remote: String,
    path: Option<String>,
) -> Result<(), String> {
    // 1. Resolve SendTo directory path
    let send_to_dir = get_send_to_dir()?;
    if !send_to_dir.exists() {
        std::fs::create_dir_all(&send_to_dir)
            .map_err(|e| format!("Failed to create SendTo directory: {e}"))?;
    }

    // 2. Resolve current executable path
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {e}"))?;

    // 3. Construct shortcut filename
    // e.g. "Dropbox - MyFolder" (RClone Manager).lnk
    let path_suffix = path
        .as_deref()
        .filter(|p| !p.is_empty() && *p != "/")
        .map(|p| {
            format!(
                " - {}",
                p.trim_start_matches('/')
                    .replace('/', " - ")
                    .replace('\\', " - ")
            )
        })
        .unwrap_or_default();

    let sanitized_suffix = path_suffix
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '-' } else { c })
        .collect::<String>();

    let name = format!(
        "{}{} (RClone Manager)",
        remote.trim_end_matches(':'),
        sanitized_suffix
    );
    let shortcut_path = send_to_dir.join(format!("{}.lnk", name));

    // 4. Construct arguments
    // --send-to-remote "remote" --send-to-path "path"
    let path_val = path.as_deref().unwrap_or("");
    let arguments = format!(
        "--send-to-remote \"{}\" --send-to-path \"{}\"",
        remote, path_val
    );

    // 5. Create the shortcut using PowerShell
    let target_str = current_exe.to_string_lossy();
    let shortcut_str = shortcut_path.to_string_lossy();
    let powershell_cmd = format!(
        "$WshShell = New-Object -ComObject WScript.Shell; \
         $Shortcut = $WshShell.CreateShortcut('{}'); \
         $Shortcut.TargetPath = '{}'; \
         $Shortcut.Arguments = '{}'; \
         $Shortcut.IconLocation = '{}'; \
         $Shortcut.Save()",
        shortcut_str.replace("'", "''"),
        target_str.replace("'", "''"),
        arguments.replace("'", "''"),
        target_str.replace("'", "''")
    );

    let powershell_executable = if which::which("powershell").is_ok() {
        "powershell"
    } else if which::which("pwsh").is_ok() {
        "pwsh"
    } else {
        return Err(
            "Neither 'powershell' nor 'pwsh' command line tools could be found on this system."
                .to_string(),
        );
    };

    let output = std::process::Command::new(powershell_executable)
        .args(&["-NoProfile", "-Command", &powershell_cmd])
        .output()
        .map_err(|e| format!("Failed to run PowerShell/pwsh to create shortcut: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("PowerShell command failed: {stderr}"));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn unregister_send_to(
    _app: tauri::AppHandle,
    remote: String,
    path: Option<String>,
) -> Result<(), String> {
    let send_to_dir = get_send_to_dir()?;
    let path_suffix = path
        .as_deref()
        .filter(|p| !p.is_empty() && *p != "/")
        .map(|p| {
            format!(
                " - {}",
                p.trim_start_matches('/')
                    .replace('/', " - ")
                    .replace('\\', " - ")
            )
        })
        .unwrap_or_default();

    let sanitized_suffix = path_suffix
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '-' } else { c })
        .collect::<String>();

    let name = format!(
        "{}{} (RClone Manager)",
        remote.trim_end_matches(':'),
        sanitized_suffix
    );
    let shortcut_path = send_to_dir.join(format!("{}.lnk", name));

    if shortcut_path.exists() {
        std::fs::remove_file(shortcut_path)
            .map_err(|e| format!("Failed to delete shortcut file: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn is_send_to_registered(
    _app: tauri::AppHandle,
    remote: String,
    path: Option<String>,
) -> Result<bool, String> {
    let send_to_dir = get_send_to_dir()?;
    let path_suffix = path
        .as_deref()
        .filter(|p| !p.is_empty() && *p != "/")
        .map(|p| {
            format!(
                " - {}",
                p.trim_start_matches('/')
                    .replace('/', " - ")
                    .replace('\\', " - ")
            )
        })
        .unwrap_or_default();

    let sanitized_suffix = path_suffix
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '-' } else { c })
        .collect::<String>();

    let name = format!(
        "{}{} (RClone Manager)",
        remote.trim_end_matches(':'),
        sanitized_suffix
    );
    let shortcut_path = send_to_dir.join(format!("{}.lnk", name));

    Ok(shortcut_path.exists())
}

#[cfg(target_os = "windows")]
fn get_send_to_dir() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "Could not find APPDATA environment variable".to_string())?;
    let mut path = std::path::PathBuf::from(appdata);
    path.push("Microsoft");
    path.push("Windows");
    path.push("SendTo");
    Ok(path)
}
