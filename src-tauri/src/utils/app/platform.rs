#[tauri::command]
#[must_use]
pub fn get_build_type() -> Option<&'static str> {
    if cfg!(feature = "flatpak") {
        Some("flatpak")
    } else if cfg!(feature = "deb") {
        Some("deb")
    } else if cfg!(feature = "rpm") {
        Some("rpm")
    } else if cfg!(feature = "arch") {
        Some("arch")
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

        let content = r"[Desktop Entry]
Type=Application
Name=RClone Manager
Comment=RClone Manager Flatpak autostart entry
Exec=/usr/bin/flatpak run io.github.zarestia_dev.rclone-manager --tray
Icon=io.github.zarestia_dev.rclone-manager
Categories=Utility;Network;
Keywords=rclone;cloud;backup;sync;storage;
X-Flatpak=io.github.zarestia_dev.rclone-manager
Terminal=false
";
        fs::write(&desktop_file_path, content)
            .map_err(|e| format!("Failed to write autostart file: {e}"))?;
    } else if desktop_file_path.exists() {
        fs::remove_file(&desktop_file_path)
            .map_err(|e| format!("Failed to remove autostart file: {e}"))?;
    }

    Ok(())
}
