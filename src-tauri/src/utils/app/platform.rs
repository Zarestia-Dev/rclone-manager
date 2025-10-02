use std::{env, fs};

/// Checks if the application is running inside a Flatpak sandbox
#[tauri::command]
pub fn is_flatpak_build() -> bool {
    // Check for Flatpak environment variable
    if env::var("FLATPAK_ID").is_ok() {
        return true;
    }

    // Check for /.flatpak-info file which exists in Flatpak containers
    if fs::metadata("/.flatpak-info").is_ok() {
        return true;
    }

    false
}

/// Get platform information including build type
#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        is_flatpak: is_flatpak_build(),
        os: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        family: env::consts::FAMILY.to_string(),
    }
}

#[derive(serde::Serialize)]
pub struct PlatformInfo {
    pub is_flatpak: bool,
    pub os: String,
    pub arch: String,
    pub family: String,
}
