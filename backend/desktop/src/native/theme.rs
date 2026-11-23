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

#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
use crate::utils::app::system_theme::detect as detect_platform_theme;

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn detect_platform_theme() -> Option<bool> {
    Some(is_system_dark())
}

// ---------------------------------------------------------------------------
// Linux Portal Value
// ---------------------------------------------------------------------------

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

    const NAMESPACE: &str = "org.freedesktop.appearance";
    const KEY: &str = "color-scheme";

    let Some(proxy) = super::portal::settings().await else {
        return;
    };

    if let Ok(res) = proxy
        .call::<_, _, zbus::OwnedVariant>("Read", &(NAMESPACE, KEY))
        .await
        && let Some(is_dark) = extract_portal_color_scheme(&res)
    {
        apply_theme_change(is_dark);
    }

    let Some(changes) = super::portal::setting_changes(NAMESPACE, KEY).await else {
        return;
    };
    let mut changes = std::pin::pin!(changes);

    log::info!("Listening for FreeDesktop XDG Portal color-scheme theme changes...");

    while let Some(msg) = changes.next().await {
        let Some(value) = super::portal::changed_value(&msg) else {
            continue;
        };
        if let Some(is_dark) = extract_portal_color_scheme(&value) {
            apply_theme_change(is_dark);
        } else if let Ok(Some(is_dark)) = crate::utils::spawn_blocking(detect_platform_theme).await
        {
            apply_theme_change(is_dark);
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
