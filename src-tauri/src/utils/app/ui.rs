#![cfg(not(feature = "web-server"))]
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

use crate::core::bridge;

static SYSTEM_THEME_IS_DARK: AtomicBool = AtomicBool::new(true);

/// Initialize the system theme during startup before UI loads
pub fn init_system_theme() {
    let is_dark = detect_system_dark();
    SYSTEM_THEME_IS_DARK.store(is_dark, Ordering::Relaxed);
    log::info!(
        "Initialized native system theme: {}",
        if is_dark { "dark" } else { "light" }
    );
}

/// Set the application theme (called from frontend IPC or bridge)
#[bridge]
pub async fn set_theme(
    system_is_dark: Option<bool>,
    #[allow(unused_variables)] window: tauri::Window,
) -> Result<(), String> {
    if let Some(is_dark) = system_is_dark {
        SYSTEM_THEME_IS_DARK.store(is_dark, Ordering::Relaxed);
    }

    #[cfg(feature = "tray")]
    {
        use tauri::Manager;
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::core::tray::core::update_tray_menu(app).await;
        });
    }

    Ok(())
}

#[must_use]
pub fn is_system_dark() -> bool {
    SYSTEM_THEME_IS_DARK.load(Ordering::Relaxed)
}

/// Apply a detected system theme change, updating tray and notifying webview frontend.
pub async fn apply_theme_change(app_handle: &tauri::AppHandle, is_dark: bool) {
    let prev = SYSTEM_THEME_IS_DARK.swap(is_dark, Ordering::Relaxed);
    if prev != is_dark {
        log::info!(
            "System theme changed: {} -> {}",
            if prev { "dark" } else { "light" },
            if is_dark { "dark" } else { "light" }
        );

        #[cfg(feature = "tray")]
        {
            let _ = crate::core::tray::core::update_tray_menu(app_handle.clone()).await;
        }

        let _ = app_handle.emit(crate::utils::types::events::SYSTEM_THEME_CHANGED, is_dark);
    }
}

/// Detects whether the current OS theme is dark.
#[must_use]
pub fn detect_system_dark() -> bool {
    #[cfg(target_os = "linux")]
    {
        detect_linux_theme().unwrap_or(false)
    }

    #[cfg(windows)]
    {
        detect_windows_theme().unwrap_or(false)
    }

    #[cfg(target_os = "macos")]
    {
        detect_macos_theme().unwrap_or(false)
    }

    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        is_system_dark()
    }
}

// ---------------------------------------------------------------------------
// Linux Theme Detection & Watcher
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
pub fn detect_linux_theme() -> Option<bool> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .or_else(|_| std::env::var("DESKTOP_SESSION"))
        .unwrap_or_default()
        .to_lowercase();

    // 1. If KDE / Plasma desktop, prioritize KDE Plasma config
    if (desktop.contains("kde") || desktop.contains("plasma"))
        && let Some(is_dark) = detect_kde_theme()
    {
        return Some(is_dark);
    }

    // 2. If GNOME / Ubuntu / Unity / Pantheon, prioritize GSettings
    if (desktop.contains("gnome")
        || desktop.contains("ubuntu")
        || desktop.contains("unity")
        || desktop.contains("pantheon"))
        && let Some(is_dark) = detect_gsettings_theme()
    {
        return Some(is_dark);
    }

    // 3. If XFCE, prioritize xfconf
    if desktop.contains("xfce")
        && let Some(is_dark) = detect_other_de_theme()
    {
        return Some(is_dark);
    }

    // General fallback: check all detection methods in sequence
    if let Some(is_dark) = detect_kde_theme() {
        return Some(is_dark);
    }

    if let Some(is_dark) = detect_gsettings_theme() {
        return Some(is_dark);
    }

    if let Some(is_dark) = detect_gtk_settings_file() {
        return Some(is_dark);
    }

    if let Some(is_dark) = detect_other_de_theme() {
        return Some(is_dark);
    }

    // 5. Check GTK_THEME environment variable
    if let Ok(theme) = std::env::var("GTK_THEME") {
        let theme_lower = theme.to_lowercase();
        if theme_lower.contains("dark") || theme_lower.contains("black") {
            return Some(true);
        }
        if theme_lower.contains("light") || theme_lower.contains("white") {
            return Some(false);
        }
    }

    None
}

/// Parses KDE Plasma `kdeglobals` content to determine dark mode.
pub fn parse_kde_globals(contents: &str) -> Option<bool> {
    let mut in_general = false;
    let mut in_colors_window = false;
    let mut color_scheme_dark: Option<bool> = None;
    let mut bg_normal_dark: Option<bool> = None;

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_general = trimmed.eq_ignore_ascii_case("[General]");
            in_colors_window = trimmed.eq_ignore_ascii_case("[Colors:Window]");
            continue;
        }

        if in_general
            && let Some((k, v)) = trimmed.split_once('=')
            && k.trim().eq_ignore_ascii_case("ColorScheme")
        {
            let val = v.trim().to_lowercase();
            if val.contains("dark") || val.contains("black") || val.contains("night") {
                color_scheme_dark = Some(true);
            } else if val.contains("light") || val.contains("white") {
                color_scheme_dark = Some(false);
            }
        }

        if in_colors_window
            && let Some((k, v)) = trimmed.split_once('=')
            && k.trim().eq_ignore_ascii_case("BackgroundNormal")
        {
            let parts: Vec<u32> = v
                .split(',')
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect();
            if parts.len() >= 3 {
                // ITU-R BT.601 luminance formula
                let lum = 0.299 * (parts[0] as f64)
                    + 0.587 * (parts[1] as f64)
                    + 0.114 * (parts[2] as f64);
                bg_normal_dark = Some(lum < 128.0);
            }
        }
    }

    color_scheme_dark.or(bg_normal_dark)
}

#[cfg(target_os = "linux")]
fn detect_kde_theme() -> Option<bool> {
    let config_dir = std::env::var("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
        .ok()?;

    let kdeglobals = config_dir.join("kdeglobals");
    if kdeglobals.exists()
        && let Ok(contents) = std::fs::read_to_string(&kdeglobals)
    {
        return parse_kde_globals(&contents);
    }
    None
}

/// Parses GTK `settings.ini` content to determine dark mode preference.
pub fn parse_gtk_settings(contents: &str) -> Option<bool> {
    let mut prefer_dark: Option<bool> = None;
    let mut theme_name_dark: Option<bool> = None;

    for line in contents.lines() {
        let trimmed = line.trim();
        if let Some((k, v)) = trimmed.split_once('=') {
            let key = k.trim().to_lowercase();
            let val = v.trim().to_lowercase();

            if key == "gtk-application-prefer-dark-theme" {
                if val == "1" || val == "true" {
                    prefer_dark = Some(true);
                } else if val == "0" || val == "false" {
                    prefer_dark = Some(false);
                }
            }

            if key == "gtk-theme-name" {
                if val.contains("dark") || val.contains("black") {
                    theme_name_dark = Some(true);
                } else if val.contains("light") || val.contains("white") {
                    theme_name_dark = Some(false);
                }
            }
        }
    }

    if prefer_dark == Some(true) || theme_name_dark == Some(true) {
        Some(true)
    } else {
        prefer_dark.or(theme_name_dark)
    }
}

#[cfg(target_os = "linux")]
fn detect_gtk_settings_file() -> Option<bool> {
    let config_dir = std::env::var("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
        .ok()?;

    for gtk_ver in &["gtk-4.0", "gtk-3.0"] {
        let settings_path = config_dir.join(gtk_ver).join("settings.ini");
        if settings_path.exists()
            && let Ok(contents) = std::fs::read_to_string(&settings_path)
            && let Some(is_dark) = parse_gtk_settings(&contents)
        {
            return Some(is_dark);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn detect_gsettings_theme() -> Option<bool> {
    // 1. color-scheme
    if let Ok(output) = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
        && output.status.success()
    {
        let val = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if val.contains("prefer-dark") {
            return Some(true);
        }
        if val.contains("prefer-light") {
            return Some(false);
        }
        // If "default" or unspecified, fall through to check gtk-theme
    }

    // 2. gtk-theme
    if let Ok(output) = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
        .output()
        && output.status.success()
    {
        let val = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if val.contains("dark") || val.contains("black") {
            return Some(true);
        }
        if val.contains("light")
            || val.contains("adwaita")
            || val.contains("yaru")
            || val.contains("breeze")
        {
            return Some(false);
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn detect_other_de_theme() -> Option<bool> {
    // Cinnamon
    if let Ok(output) = std::process::Command::new("gsettings")
        .args(["get", "org.cinnamon.desktop.interface", "gtk-theme"])
        .output()
        && output.status.success()
    {
        let val = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if val.contains("dark") {
            return Some(true);
        }
        if val.contains("light") {
            return Some(false);
        }
    }

    // XFCE
    if let Ok(output) = std::process::Command::new("xfconf-query")
        .args(["-c", "xsettings", "-p", "/Net/ThemeName"])
        .output()
        && output.status.success()
    {
        let val = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if val.contains("dark") {
            return Some(true);
        }
        if val.contains("light") {
            return Some(false);
        }
    }

    None
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
pub fn extract_portal_color_scheme(val: &zbus::zvariant::Value) -> Option<bool> {
    match val {
        zbus::zvariant::Value::U32(1)
        | zbus::zvariant::Value::U8(1)
        | zbus::zvariant::Value::I32(1)
        | zbus::zvariant::Value::I64(1)
        | zbus::zvariant::Value::U64(1) => Some(true),
        zbus::zvariant::Value::U32(2)
        | zbus::zvariant::Value::U8(2)
        | zbus::zvariant::Value::I32(2)
        | zbus::zvariant::Value::I64(2)
        | zbus::zvariant::Value::U64(2) => Some(false),
        zbus::zvariant::Value::Value(inner) => extract_portal_color_scheme(inner),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Windows Theme Detection
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub fn detect_windows_theme() -> Option<bool> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .ok()?;

    if let Ok(apps_light) = key.get_value::<u32, _>("AppsUseLightTheme") {
        return Some(apps_light == 0);
    }
    if let Ok(sys_light) = key.get_value::<u32, _>("SystemUsesLightTheme") {
        return Some(sys_light == 0);
    }

    None
}

// ---------------------------------------------------------------------------
// macOS Theme Detection
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub fn detect_macos_theme() -> Option<bool> {
    if let Ok(output) = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
    {
        if output.status.success() {
            let style = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Some(style.eq_ignore_ascii_case("Dark"));
        }
        // If AppleInterfaceStyle is not set or exits with error, it is Light mode
        return Some(false);
    }
    None
}

// ---------------------------------------------------------------------------
// Background Watcher / Watchdog
// ---------------------------------------------------------------------------

/// Starts background monitoring for OS theme changes.
pub fn monitor_theme_changes(_app_handle: tauri::AppHandle) {
    #[cfg(all(feature = "desktop", target_os = "linux"))]
    {
        tauri::async_runtime::spawn(async move {
            run_linux_portal_watcher(_app_handle).await;
        });
    }

    #[cfg(all(feature = "desktop", windows))]
    {
        tauri::async_runtime::spawn(async move {
            run_windows_theme_watcher(_app_handle).await;
        });
    }

    #[cfg(all(feature = "desktop", target_os = "macos"))]
    {
        tauri::async_runtime::spawn(async move {
            run_macos_theme_watcher(_app_handle).await;
        });
    }
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
async fn run_linux_portal_watcher(app_handle: tauri::AppHandle) {
    use futures_lite::stream::StreamExt;
    use zbus::Connection;

    let connection = match Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            log::debug!("Failed to connect to D-Bus session bus for portal theme monitoring: {e}");
            return;
        }
    };

    let proxy = match zbus::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Settings",
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            log::debug!("Failed to create FreeDesktop Portal Settings D-Bus proxy: {e}");
            return;
        }
    };

    // Initial read from portal if available
    if let Ok(res) = proxy
        .call::<_, _, zbus::zvariant::OwnedValue>(
            "Read",
            &("org.freedesktop.appearance", "color-scheme"),
        )
        .await
        && let Some(is_dark) = extract_portal_color_scheme(&res)
    {
        apply_theme_change(&app_handle, is_dark).await;
    }

    let signal_res = proxy.receive_signal("SettingChanged").await;
    let mut signal_stream = match signal_res {
        Ok(stream) => stream,
        Err(e) => {
            log::debug!("Failed to subscribe to portal SettingChanged signal: {e}");
            return;
        }
    };

    log::info!("Listening for FreeDesktop XDG Portal color-scheme theme changes...");

    while let Some(msg) = signal_stream.next().await {
        if let Ok((namespace, key, value)) = msg
            .body()
            .deserialize::<(String, String, zbus::zvariant::OwnedValue)>()
            && namespace == "org.freedesktop.appearance"
            && key == "color-scheme"
        {
            if let Some(is_dark) = extract_portal_color_scheme(&value) {
                apply_theme_change(&app_handle, is_dark).await;
            } else if let Some(is_dark) = detect_linux_theme() {
                apply_theme_change(&app_handle, is_dark).await;
            }
        }
    }
}

#[cfg(all(feature = "desktop", windows))]
async fn run_windows_theme_watcher(app_handle: tauri::AppHandle) {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, KEY_NOTIFY, REG_NOTIFY_CHANGE_LAST_SET, RegCloseKey,
        RegNotifyChangeKeyValue, RegOpenKeyExW,
    };
    use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};

    std::thread::spawn(move || {
        let subkey: Vec<u16> =
            "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
                .encode_utf16()
                .collect();
        let mut h_key = std::ptr::null_mut();

        unsafe {
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_NOTIFY,
                &mut h_key,
            ) != 0
            {
                log::debug!("Failed to open Windows Personalize registry key for theme monitoring");
                return;
            }

            let event = CreateEventW(std::ptr::null(), FALSE, FALSE, std::ptr::null());
            if event.is_null() {
                RegCloseKey(h_key);
                return;
            }

            log::info!("Listening for Windows OS theme changes via registry events...");

            loop {
                if RegNotifyChangeKeyValue(
                    h_key,
                    FALSE,
                    REG_NOTIFY_CHANGE_LAST_SET,
                    event,
                    1, // TRUE (asynchronous, signals event)
                ) != 0
                {
                    break;
                }

                if WaitForSingleObject(event, INFINITE) == WAIT_OBJECT_0 {
                    let is_dark = detect_windows_theme().unwrap_or(false);
                    let handle = app_handle.clone();
                    tauri::async_runtime::block_on(async move {
                        apply_theme_change(&handle, is_dark).await;
                    });
                }
            }

            CloseHandle(event);
            RegCloseKey(h_key);
        }
    });
}

#[cfg(all(feature = "desktop", target_os = "macos"))]
async fn run_macos_theme_watcher(app_handle: tauri::AppHandle) {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    extern "C" {
        fn CFNotificationCenterGetDistributedCenter() -> *const c_void;
        fn CFNotificationCenterAddObserver(
            center: *const c_void,
            observer: *const c_void,
            callback: extern "C" fn(
                *const c_void,
                *mut c_void,
                *const c_void,
                *const c_void,
                *const c_void,
            ),
            name: *const c_void,
            object: *const c_void,
            suspensionBehavior: usize,
        );
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            cStr: *const std::os::raw::c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

    extern "C" fn theme_changed_callback(
        _center: *const c_void,
        _observer: *mut c_void,
        _name: *const c_void,
        _object: *const c_void,
        _user_info: *const c_void,
    ) {
        let is_dark = detect_macos_theme().unwrap_or(false);
        if let Some(handle) = APP_HANDLE.get() {
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                apply_theme_change(&handle_clone, is_dark).await;
            });
        }
    }

    let _ = APP_HANDLE.set(app_handle);
    unsafe {
        let center = CFNotificationCenterGetDistributedCenter();
        let notification_name = CFStringCreateWithCString(
            std::ptr::null(),
            b"AppleInterfaceThemeChangedNotification\0".as_ptr() as *const _,
            0x08000100, // kCFStringEncodingUTF8
        );

        if !center.is_null() && !notification_name.is_null() {
            log::info!("Listening for macOS AppleInterfaceThemeChangedNotification...");
            CFNotificationCenterAddObserver(
                center,
                std::ptr::null(),
                theme_changed_callback,
                notification_name,
                std::ptr::null(),
                2, // CFNotificationSuspensionBehaviorDeliverImmediately
            );
            CFRelease(notification_name);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_kde_globals_dark_color_scheme() {
        let contents = r#"
[General]
ColorScheme=BreezeDark
Name=Breeze Dark

[Colors:Window]
BackgroundNormal=49,54,59
ForegroundNormal=239,240,241
"#;
        assert_eq!(parse_kde_globals(contents), Some(true));
    }

    #[test]
    fn test_parse_kde_globals_light_color_scheme() {
        let contents = r#"
[General]
ColorScheme=BreezeLight
Name=Breeze Light

[Colors:Window]
BackgroundNormal=239,240,241
ForegroundNormal=49,54,59
"#;
        assert_eq!(parse_kde_globals(contents), Some(false));
    }

    #[test]
    fn test_parse_kde_globals_custom_dark_by_luminance() {
        let contents = r#"
[General]
ColorScheme=NordicCustom

[Colors:Window]
BackgroundNormal=46,52,64
"#;
        assert_eq!(parse_kde_globals(contents), Some(true));
    }

    #[test]
    fn test_parse_kde_globals_custom_light_by_luminance() {
        let contents = r#"
[General]
ColorScheme=CustomWhite

[Colors:Window]
BackgroundNormal=250,250,250
"#;
        assert_eq!(parse_kde_globals(contents), Some(false));
    }

    #[test]
    fn test_parse_gtk_settings_prefer_dark() {
        let contents = r#"
[Settings]
gtk-theme-name=Adwaita
gtk-application-prefer-dark-theme=1
"#;
        assert_eq!(parse_gtk_settings(contents), Some(true));
    }

    #[test]
    fn test_parse_gtk_settings_dark_theme_name() {
        let contents = r#"
[Settings]
gtk-theme-name=Yaru-dark
gtk-application-prefer-dark-theme=0
"#;
        assert_eq!(parse_gtk_settings(contents), Some(true));
    }

    #[test]
    fn test_parse_gtk_settings_light() {
        let contents = r#"
[Settings]
gtk-theme-name=Adwaita
gtk-application-prefer-dark-theme=0
"#;
        assert_eq!(parse_gtk_settings(contents), Some(false));
    }

    #[test]
    fn test_atomic_system_dark_state() {
        SYSTEM_THEME_IS_DARK.store(true, Ordering::Relaxed);
        assert!(is_system_dark());

        SYSTEM_THEME_IS_DARK.store(false, Ordering::Relaxed);
        assert!(!is_system_dark());
    }

    #[cfg(all(feature = "desktop", target_os = "linux"))]
    #[test]
    fn test_extract_portal_color_scheme() {
        use zbus::zvariant::Value;

        let dark_val = Value::U32(1);
        assert_eq!(extract_portal_color_scheme(&dark_val), Some(true));

        let light_val = Value::U32(2);
        assert_eq!(extract_portal_color_scheme(&light_val), Some(false));

        let default_val = Value::U32(0);
        assert_eq!(extract_portal_color_scheme(&default_val), None);

        let nested_dark = Value::Value(Box::new(Value::U32(1)));
        assert_eq!(extract_portal_color_scheme(&nested_dark), Some(true));
    }
}
