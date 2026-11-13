use std::sync::atomic::{AtomicBool, Ordering};

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
#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn set_theme(system_is_dark: Option<bool>) -> Result<(), String> {
    if let Some(is_dark) = system_is_dark {
        SYSTEM_THEME_IS_DARK.store(is_dark, Ordering::Relaxed);
    }

    crate::services::bridge::emit(crate::utils::types::events::UPDATE_TRAY_MENU, ());

    Ok(())
}

#[cfg(any(
    feature = "tray",
    test,
    not(any(target_os = "linux", windows, target_os = "macos"))
))]
#[must_use]
pub fn is_system_dark() -> bool {
    SYSTEM_THEME_IS_DARK.load(Ordering::Relaxed)
}

/// Apply a detected system theme change, updating tray and notifying webview frontend.
#[cfg(all(
    feature = "desktop",
    any(target_os = "linux", windows, target_os = "macos")
))]
pub fn apply_theme_change(is_dark: bool) {
    let prev = SYSTEM_THEME_IS_DARK.swap(is_dark, Ordering::Relaxed);
    if prev != is_dark {
        log::info!(
            "System theme changed: {} -> {}",
            if prev { "dark" } else { "light" },
            if is_dark { "dark" } else { "light" }
        );

        crate::services::bridge::emit(crate::utils::types::events::UPDATE_TRAY_MENU, ());

        crate::services::bridge::emit(crate::utils::types::events::SYSTEM_THEME_CHANGED, is_dark);
    }
}

/// Detects whether the current OS theme is dark.
#[must_use]
pub fn detect_system_dark() -> bool {
    detect_platform_theme().unwrap_or(false)
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn detect_platform_theme() -> Option<bool> {
    Some(is_system_dark())
}

// ---------------------------------------------------------------------------
// Linux Theme Detection & Watcher
// ---------------------------------------------------------------------------

/// Classifies a theme name or setting value; "dark" wins when both match.
#[cfg(any(target_os = "linux", test))]
fn classify_theme_name(name: &str, dark: &[&str], light: &[&str]) -> Option<bool> {
    let name = name.to_lowercase();
    if dark.iter().any(|word| name.contains(word)) {
        Some(true)
    } else if light.iter().any(|word| name.contains(word)) {
        Some(false)
    } else {
        None
    }
}

/// Common GTK/KDE naming: `*-dark`, `*Black`, `*-light`, `*White`.
#[cfg(any(target_os = "linux", test))]
fn classify_common_theme_name(name: &str) -> Option<bool> {
    classify_theme_name(name, &["dark", "black"], &["light", "white"])
}

/// A place a Linux desktop keeps its theme, with the desktops that own it.
#[cfg(target_os = "linux")]
type ThemeSource = (&'static [&'static str], fn() -> Option<bool>);

#[cfg(target_os = "linux")]
const THEME_SOURCES: [ThemeSource; 4] = [
    (&["kde", "plasma"], detect_kde_theme),
    (
        &["gnome", "ubuntu", "unity", "pantheon"],
        detect_gsettings_theme,
    ),
    (&[], detect_gtk_settings_file),
    (&["xfce"], detect_other_de_theme),
];

#[cfg(target_os = "linux")]
fn detect_platform_theme() -> Option<bool> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .or_else(|_| std::env::var("DESKTOP_SESSION"))
        .unwrap_or_default()
        .to_lowercase();

    // The running desktop's own source first, then every other one exactly once. The sort
    // is stable, so the others keep the order above.
    let mut sources = THEME_SOURCES;
    sources.sort_by_key(|(owners, _)| !owners.iter().any(|owner| desktop.contains(owner)));
    sources.iter().find_map(|(_, detect)| detect()).or_else(|| {
        std::env::var("GTK_THEME")
            .ok()
            .and_then(|theme| classify_common_theme_name(&theme))
    })
}

/// `$XDG_CONFIG_HOME`, or `~/.config` when it is unset.
#[cfg(target_os = "linux")]
fn config_home() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".config"))
        })
}

/// Trimmed, lowercased stdout of a command that exited successfully.
#[cfg(target_os = "linux")]
fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_lowercase()
    })
}

/// Parses KDE Plasma `kdeglobals` content to determine dark mode.
#[cfg(any(target_os = "linux", test))]
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
            color_scheme_dark =
                classify_theme_name(v, &["dark", "black", "night"], &["light", "white"])
                    .or(color_scheme_dark);
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
    let contents = std::fs::read_to_string(config_home()?.join("kdeglobals")).ok()?;
    parse_kde_globals(&contents)
}

/// Parses GTK `settings.ini` content to determine dark mode preference.
#[cfg(any(target_os = "linux", test))]
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
                theme_name_dark = classify_common_theme_name(&val).or(theme_name_dark);
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
    let config_dir = config_home()?;
    ["gtk-4.0", "gtk-3.0"].iter().find_map(|version| {
        let contents =
            std::fs::read_to_string(config_dir.join(version).join("settings.ini")).ok()?;
        parse_gtk_settings(&contents)
    })
}

#[cfg(target_os = "linux")]
fn detect_gsettings_theme() -> Option<bool> {
    let setting = |schema: &str, key: &str| command_output("gsettings", &["get", schema, key]);

    // "default" or unspecified falls through to the GTK theme name.
    if let Some(scheme) = setting("org.gnome.desktop.interface", "color-scheme") {
        if scheme.contains("prefer-dark") {
            return Some(true);
        }
        if scheme.contains("prefer-light") {
            return Some(false);
        }
    }

    let theme = setting("org.gnome.desktop.interface", "gtk-theme")?;
    classify_theme_name(
        &theme,
        &["dark", "black"],
        &["light", "adwaita", "yaru", "breeze"],
    )
}

#[cfg(target_os = "linux")]
fn detect_other_de_theme() -> Option<bool> {
    let cinnamon = command_output(
        "gsettings",
        &["get", "org.cinnamon.desktop.interface", "gtk-theme"],
    );
    let xfce = || command_output("xfconf-query", &["-c", "xsettings", "-p", "/Net/ThemeName"]);
    cinnamon
        .and_then(|theme| classify_theme_name(&theme, &["dark"], &["light"]))
        .or_else(|| xfce().and_then(|theme| classify_theme_name(&theme, &["dark"], &["light"])))
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
pub fn extract_portal_color_scheme(val: &zbus::Variant) -> Option<bool> {
    match val {
        zbus::Variant::U32(1)
        | zbus::Variant::U8(1)
        | zbus::Variant::I32(1)
        | zbus::Variant::I64(1)
        | zbus::Variant::U64(1) => Some(true),
        zbus::Variant::U32(2)
        | zbus::Variant::U8(2)
        | zbus::Variant::I32(2)
        | zbus::Variant::I64(2)
        | zbus::Variant::U64(2) => Some(false),
        zbus::Variant::Variant(inner) => extract_portal_color_scheme(inner),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Windows Theme Detection
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn detect_platform_theme() -> Option<bool> {
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
fn detect_platform_theme() -> Option<bool> {
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
#[cfg(not(target_os = "android"))]
pub fn monitor_theme_changes() {
    #[cfg(all(
        feature = "desktop",
        any(target_os = "linux", windows, target_os = "macos")
    ))]
    crate::utils::spawn(run_theme_watcher());
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
async fn run_theme_watcher() {
    use futures::StreamExt;
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

    if let Ok(res) = proxy
        .call::<_, _, zbus::OwnedVariant>("Read", &("org.freedesktop.appearance", "color-scheme"))
        .await
        && let Some(is_dark) = extract_portal_color_scheme(&res)
    {
        apply_theme_change(is_dark);
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
            .deserialize::<(String, String, zbus::OwnedVariant)>()
            && namespace == "org.freedesktop.appearance"
            && key == "color-scheme"
        {
            if let Some(is_dark) = extract_portal_color_scheme(&value) {
                apply_theme_change(is_dark);
            } else if let Ok(Some(is_dark)) =
                crate::utils::spawn_blocking(detect_platform_theme).await
            {
                apply_theme_change(is_dark);
            }
        }
    }
}

#[cfg(all(feature = "desktop", windows))]
async fn run_theme_watcher() {
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
                    apply_theme_change(detect_platform_theme().unwrap_or(false));
                }
            }

            CloseHandle(event);
            RegCloseKey(h_key);
        }
    });
}

#[cfg(all(feature = "desktop", target_os = "macos"))]
async fn run_theme_watcher() {
    use std::ffi::c_void;

    unsafe extern "C" {
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

    extern "C" fn theme_changed_callback(
        _center: *const c_void,
        _observer: *mut c_void,
        _name: *const c_void,
        _object: *const c_void,
        _user_info: *const c_void,
    ) {
        apply_theme_change(detect_platform_theme().unwrap_or(false));
    }

    unsafe {
        let center = CFNotificationCenterGetDistributedCenter();
        let notification_name = CFStringCreateWithCString(
            std::ptr::null(),
            c"AppleInterfaceThemeChangedNotification".as_ptr(),
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
    fn theme_names_are_classified_with_dark_taking_precedence() {
        assert_eq!(classify_common_theme_name("Yaru-Dark"), Some(true));
        assert_eq!(classify_common_theme_name("Adwaita-light"), Some(false));
        assert_eq!(classify_common_theme_name("HighContrastInverse"), None);
        assert_eq!(classify_common_theme_name("dark-on-white"), Some(true));
        assert_eq!(
            classify_theme_name("'Breeze'", &["dark"], &["light", "breeze"]),
            Some(false)
        );
        assert_eq!(classify_theme_name("", &["dark"], &["light"]), None);
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
        use zbus::Variant;

        for value in [
            Variant::U8(1),
            Variant::U32(1),
            Variant::I32(1),
            Variant::I64(1),
            Variant::U64(1),
        ] {
            assert_eq!(extract_portal_color_scheme(&value), Some(true));
        }
        for value in [
            Variant::U8(2),
            Variant::U32(2),
            Variant::I32(2),
            Variant::I64(2),
            Variant::U64(2),
        ] {
            assert_eq!(extract_portal_color_scheme(&value), Some(false));
        }
        for value in [
            Variant::U32(0),
            Variant::U32(3),
            Variant::I32(-1),
            Variant::from("dark"),
            Variant::from(false),
        ] {
            assert_eq!(extract_portal_color_scheme(&value), None);
        }
        for (value, expected) in [(1, Some(true)), (2, Some(false)), (0, None)] {
            let nested =
                Variant::Variant(Box::new(Variant::Variant(Box::new(Variant::U32(value)))));
            assert_eq!(extract_portal_color_scheme(&nested), expected);
        }
    }
}
