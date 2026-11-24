//! The system accent colour, which the interface uses as its primary colour while
//! Preferences > General > System Accent Color is on. Linux reads it from the XDG settings
//! portal (GNOME 47 and later, KDE Plasma 6), Windows from `UISettings`, and macOS from
//! `NSColor.controlAccentColor`. Changes arrive as `SYSTEM_ACCENT_COLOR_CHANGED`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

/// The accent colour as `#rrggbb`, or `None` when the system has none. The first call also
/// starts following changes.
pub(super) async fn accent_color() -> Option<String> {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if !WATCHING.swap(true, Ordering::SeqCst) {
        platform::watch();
    }
    platform::accent_color().await
}

/// Tells the interface about a new accent colour. Systems report a change more than once
/// (GNOME's portal sends every change twice, and Windows reports every colour change), so a
/// colour that is already current is not sent again.
fn changed(color: Option<String>) {
    static LAST: Mutex<Option<Option<String>>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap_or_else(PoisonError::into_inner);
        if last.as_ref() == Some(&color) {
            return;
        }
        *last = Some(color.clone());
    }
    crate::services::bridge::emit(
        crate::utils::types::events::SYSTEM_ACCENT_COLOR_CHANGED,
        color,
    );
}

/// A colour with channels from 0 to 1 as `#rrggbb`, or `None` when a channel is out of range.
fn hex_color(red: f64, green: f64, blue: f64) -> Option<String> {
    let channel = |level: f64| {
        (0.0..=1.0)
            .contains(&level)
            .then(|| (level * 255.0).round() as u8)
    };
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        channel(red)?,
        channel(green)?,
        channel(blue)?
    ))
}

#[cfg(target_os = "linux")]
mod platform {
    const APPEARANCE: &str = "org.freedesktop.appearance";
    const ACCENT_COLOR: &str = "accent-color";

    pub(super) async fn accent_color() -> Option<String> {
        let value = super::super::portal::settings()
            .await?
            .call::<_, _, zbus::OwnedVariant>("Read", &(APPEARANCE, ACCENT_COLOR))
            .await
            .ok()?;
        portal_accent_color(&value)
    }

    pub(super) fn watch() {
        crate::utils::spawn(async {
            use futures::StreamExt;

            let Some(changes) =
                super::super::portal::setting_changes(APPEARANCE, ACCENT_COLOR).await
            else {
                return;
            };
            let mut changes = std::pin::pin!(changes);
            while let Some(message) = changes.next().await {
                if let Some(value) = super::super::portal::changed_value(&message) {
                    super::changed(portal_accent_color(&value));
                }
            }
        });
    }

    /// The colour in a portal `accent-color` value: red, green and blue doubles from 0 to 1.
    /// A value outside that range means the desktop has no accent colour.
    pub(super) fn portal_accent_color(value: &zbus::Variant) -> Option<String> {
        let channel = |field: &zbus::Variant| match field {
            zbus::Variant::F64(level) => Some(*level),
            _ => None,
        };
        match value {
            zbus::Variant::Structure(color) => {
                let [red, green, blue] = color.fields() else {
                    return None;
                };
                super::hex_color(channel(red)?, channel(green)?, channel(blue)?)
            }
            zbus::Variant::Variant(inner) => portal_accent_color(inner),
            _ => None,
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows::Foundation::TypedEventHandler;
    use windows::UI::ViewManagement::{UIColorType, UISettings};

    pub(super) async fn accent_color() -> Option<String> {
        read(&UISettings::new().ok()?)
    }

    fn read(settings: &UISettings) -> Option<String> {
        let color = settings.GetColorValue(UIColorType::Accent).ok()?;
        super::hex_color(
            f64::from(color.R) / 255.0,
            f64::from(color.G) / 255.0,
            f64::from(color.B) / 255.0,
        )
    }

    pub(super) fn watch() {
        let Ok(settings) = UISettings::new() else {
            return;
        };
        // Fires on a background thread for every system colour change, not only the accent.
        let handler = TypedEventHandler::new(|sender, _| {
            let sender: &Option<UISettings> = &sender;
            if let Some(settings) = sender {
                super::changed(read(settings));
            }
            Ok(())
        });
        if let Err(e) = settings.ColorValuesChanged(&handler) {
            log::warn!("Cannot follow the system accent colour: {e}");
            return;
        }
        // The event only fires while this UISettings lives, so it is kept for the app's life.
        static WATCHED: std::sync::OnceLock<UISettings> = std::sync::OnceLock::new();
        let _ = WATCHED.set(settings);
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2_app_kit::{NSColor, NSColorSpace, NSSystemColorsDidChangeNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;

    pub(super) async fn accent_color() -> Option<String> {
        read()
    }

    /// The accent in sRGB. "Multicolor", the default, reports the system blue.
    fn read() -> Option<String> {
        let color =
            NSColor::controlAccentColor().colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        super::hex_color(
            color.redComponent(),
            color.greenComponent(),
            color.blueComponent(),
        )
    }

    pub(super) fn watch() {
        // AppKit posts this when the user picks another accent (or highlight) colour.
        let block = RcBlock::new(|_: NonNull<NSNotification>| super::changed(read()));
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSSystemColorsDidChangeNotification),
                None,
                None,
                &block,
            )
        };
        // The observer stays registered while the returned token lives, so ownership is given
        // up to keep it for the app's life.
        let _ = objc2::rc::Retained::into_raw(observer);
    }
}

#[cfg(test)]
mod tests {
    use super::hex_color;

    #[test]
    fn hex_color_rounds_each_channel() {
        assert_eq!(hex_color(0.208, 0.518, 0.894), Some("#3584e4".to_string()));
        assert_eq!(hex_color(1.0, 0.0, 0.5), Some("#ff0080".to_string()));
        assert_eq!(hex_color(-1.0, 0.5, 0.5), None);
        assert_eq!(hex_color(0.5, 0.5, 1.5), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn portal_accent_color_reads_the_rgb_doubles() {
        use super::platform::portal_accent_color;
        let color = |red: f64, green: f64, blue: f64| {
            zbus::Variant::Structure(zbus::Structure::from((red, green, blue)))
        };
        // GNOME's default blue, #3584e4.
        let blue = color(0.208, 0.518, 0.894);
        assert_eq!(portal_accent_color(&blue), Some("#3584e4".to_string()));
        assert_eq!(
            portal_accent_color(&zbus::Variant::Variant(Box::new(color(1.0, 0.0, 0.5)))),
            Some("#ff0080".to_string())
        );
        // Out of range: the desktop has no accent colour.
        assert_eq!(portal_accent_color(&color(-1.0, -1.0, -1.0)), None);
        assert_eq!(portal_accent_color(&zbus::Variant::from("blue")), None);
    }
}
