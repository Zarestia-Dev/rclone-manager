#[cfg(not(feature = "web-server"))]
use tauri::Theme;

/// Set the application theme
#[tauri::command]
#[cfg(all(desktop, not(feature = "web-server")))]
pub async fn set_theme(theme: String, window: tauri::Window) -> Result<(), String> {
    let theme_enum = match theme.as_str() {
        "dark" => Theme::Dark,
        _ => Theme::Light,
    };

    if window.theme().unwrap_or(Theme::Light) != theme_enum {
        window.set_theme(Some(theme_enum)).map_err(
            |e| crate::localized_error!("backendErrors.system.themeSetFailed", "error" => e),
        )?;
    }

    Ok(())
}

/// Set the application theme (mobile no-op)
#[tauri::command]
#[cfg(not(desktop))]
pub async fn set_theme(_theme: String, _window: tauri::Window) -> Result<(), String> {
    // Theme setting is not supported on mobile
    Ok(())
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub fn get_system_theme() -> String {
    match detect_system_theme() {
        Theme::Dark => "dark".to_string(),
        Theme::Light => "light".to_string(),
        _ => "light".to_string(),
    }
}

#[cfg(not(feature = "web-server"))]
fn detect_system_theme() -> Theme {
    #[cfg(target_os = "macos")]
    {
        detect_macos_theme()
    }
    #[cfg(target_os = "windows")]
    {
        detect_windows_theme()
    }
    #[cfg(target_os = "linux")]
    {
        detect_linux_theme()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Theme::Dark
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_theme() -> Theme {
    use std::process::Command;

    match Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
    {
        Ok(output) if output.status.success() => {
            let out = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
            if out.contains("dark") {
                Theme::Dark
            } else {
                Theme::Light
            }
        }
        Ok(_) => {
            // Command succeeded but didn't return success status
            // This typically means the key doesn't exist (light mode)
            Theme::Light
        }
        Err(e) => {
            eprintln!("Failed to detect macOS theme: {}", e);
            Theme::Light
        }
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_theme() -> Theme {
    use std::process::Command;

    match Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "AppsUseLightTheme",
        ])
        .output()
    {
        Ok(output) if output.status.success() => {
            let out = String::from_utf8_lossy(&output.stdout);

            // Parse the registry value more precisely
            if let Some(theme) = parse_windows_registry_value(&out) {
                theme
            } else {
                Theme::Light
            }
        }
        Ok(_) | Err(_) => {
            if let Err(e) = Command::new("reg").output() {
                eprintln!("Failed to detect Windows theme: {}", e);
            }
            Theme::Light
        }
    }
}

#[cfg(target_os = "windows")]
fn parse_windows_registry_value(output: &str) -> Option<Theme> {
    // Look for the REG_DWORD value in the output
    // Format: "AppsUseLightTheme    REG_DWORD    0x0" or "0x1"
    for line in output.lines() {
        if line.contains("AppsUseLightTheme") && line.contains("REG_DWORD") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(value_str) = parts.last() {
                // Check for hex values: 0x0 or 0x00000000 means dark, 0x1 or 0x00000001 means light
                let value_lower = value_str.to_lowercase();
                if value_lower == "0x0" || value_lower == "0x00000000" {
                    return Some(Theme::Dark);
                } else if value_lower == "0x1" || value_lower == "0x00000001" {
                    return Some(Theme::Light);
                }
            }
        }
    }
    None
}

#[cfg(all(target_os = "linux", not(feature = "web-server")))]
fn detect_linux_theme() -> Theme {
    use std::process::Command;

    // Try GNOME color-scheme (modern method, GNOME 42+)
    if let Ok(output) = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
        && output.status.success()
    {
        let out = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        if out.contains("dark") {
            return Theme::Dark;
        } else if out.contains("light") {
            return Theme::Light;
        }
    }

    // Try GNOME gtk-theme (legacy method)
    if let Ok(output) = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
        .output()
        && output.status.success()
    {
        let out = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        if out.contains("dark") {
            return Theme::Dark;
        }
    }

    // Try KDE Plasma (kreadconfig5 or kreadconfig6)
    for kde_cmd in &["kreadconfig6", "kreadconfig5"] {
        if let Ok(output) = Command::new(kde_cmd)
            .args(["--group", "General", "--key", "ColorScheme"])
            .output()
            && output.status.success()
        {
            let out = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
            if out.contains("dark") {
                return Theme::Dark;
            }
        }
    }

    // Try XFCE
    if let Ok(output) = Command::new("xfconf-query")
        .args(["-c", "xsettings", "-p", "/Net/ThemeName"])
        .output()
        && output.status.success()
    {
        let out = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        if out.contains("dark") {
            return Theme::Dark;
        }
    }

    // Check environment variables as last resort
    if let Ok(gtk_theme) = std::env::var("GTK_THEME")
        && gtk_theme.to_lowercase().contains("dark")
    {
        return Theme::Dark;
    }

    // Default to light theme
    Theme::Light
}
