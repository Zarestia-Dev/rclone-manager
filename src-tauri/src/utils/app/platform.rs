#[tauri::command]
pub fn get_build_type() -> Option<&'static str> {
    #[cfg(feature = "flatpak")]
    {
        return Some("flatpak");
    }
    #[cfg(feature = "deb")]
    {
        return Some("deb");
    }
    #[cfg(feature = "rpm")]
    {
        return Some("rpm");
    }
    #[cfg(feature = "arch")]
    {
        return Some("arch");
    }

    // Default: not a packaged build
    None
}

/// Check if updates are disabled for this build
#[tauri::command]
pub fn are_updates_disabled() -> bool {
    get_build_type().is_some()
}

#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(feature = "flatpak")]
pub fn manage_flatpak_autostart(enable: bool) -> Result<(), String> {
    use std::fs;
    use std::path::PathBuf;

    // Standard XDG autostart path: ~/.config/autostart/
    // Flatpak has permission to write here (filesystem=xdg-config/autostart:create)
    let home = std::env::var("HOME").map_err(|_| "Could not find HOME environment variable")?;
    let home_dir = PathBuf::from(home);
    let autostart_dir = home_dir.join(".config/autostart");
    let desktop_file_path = autostart_dir.join("io.github.zarestia_dev.rclone-manager.desktop");

    if enable {
        if !autostart_dir.exists() {
            fs::create_dir_all(&autostart_dir)
                .map_err(|e| format!("Failed to create autostart directory: {e}"))?;
        }

        let content = r#"[Desktop Entry]
Type=Application
Name=RClone Manager
Comment=RClone Manager flatpak autostart entry (Not handled by tauri)
Exec=/usr/bin/flatpak run io.github.zarestia_dev.rclone-manager --tray
X-Flatpak=io.github.zarestia_dev.rclone-manager
Terminal=false
"#;
        fs::write(&desktop_file_path, content)
            .map_err(|e| format!("Failed to write autostart file: {e}"))?;
    } else {
        if desktop_file_path.exists() {
            fs::remove_file(&desktop_file_path)
                .map_err(|e| format!("Failed to remove autostart file: {e}"))?;
        }
    }

    Ok(())
}
