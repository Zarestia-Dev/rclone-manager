use tauri::image::Image;

const ICON_COLOR_NORMAL: &[u8] = include_bytes!("../../../icons/rclone_symbolic.png");
const ICON_COLOR_ACTIVE: &[u8] = include_bytes!("../../../icons/rclone_symbolic_active.png");

const ICON_MONO_LIGHT_NORMAL: &[u8] = include_bytes!("../../../icons/rclone_monochrome_light.png");
const ICON_MONO_LIGHT_ACTIVE: &[u8] =
    include_bytes!("../../../icons/rclone_monochrome_light_active.png");

const ICON_MONO_DARK_NORMAL: &[u8] = include_bytes!("../../../icons/rclone_monochrome_dark.png");
const ICON_MONO_DARK_ACTIVE: &[u8] =
    include_bytes!("../../../icons/rclone_monochrome_dark_active.png");

/// Returns the tray icon image based on active state and the selected icon theme style.
pub fn get_icon(is_active: bool, theme_style: &str) -> tauri::Result<Image<'static>> {
    let bytes = match theme_style {
        "color" => {
            if is_active {
                ICON_COLOR_ACTIVE
            } else {
                ICON_COLOR_NORMAL
            }
        }
        "monochrome_light" => {
            if is_active {
                ICON_MONO_LIGHT_ACTIVE
            } else {
                ICON_MONO_LIGHT_NORMAL
            }
        }
        "monochrome_dark" => {
            if is_active {
                ICON_MONO_DARK_ACTIVE
            } else {
                ICON_MONO_DARK_NORMAL
            }
        }
        // "system" or any fallback: auto-detect system theme
        _ => {
            let is_dark = is_system_dark();
            if is_dark {
                if is_active {
                    ICON_MONO_LIGHT_ACTIVE
                } else {
                    ICON_MONO_LIGHT_NORMAL
                }
            } else if is_active {
                ICON_MONO_DARK_ACTIVE
            } else {
                ICON_MONO_DARK_NORMAL
            }
        }
    };
    Image::from_bytes(bytes)
}

fn is_system_dark() -> bool {
    #[cfg(not(feature = "web-server"))]
    {
        crate::utils::app::ui::is_system_dark()
    }
    #[cfg(feature = "web-server")]
    {
        true
    }
}
