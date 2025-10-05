#[tauri::command]
pub fn get_build_type() -> Option<&'static str> {
    #[cfg(feature = "flatpak")]
    {
        Some("flatpak")
    }
    #[cfg(feature = "deb")]
    {
        Some("deb")
    }
    #[cfg(feature = "rpm")]
    {
        Some("rpm")
    }
    #[cfg(feature = "arch")]
    {
        Some("arch")
    }
    #[cfg(not(any(
        feature = "flatpak",
        feature = "deb",
        feature = "rpm",
        feature = "arch"
    )))]
    {
        None
    }
}

/// Check if updates are disabled for this build
#[tauri::command]
pub fn are_updates_disabled() -> bool {
    get_build_type().is_some()
}
