use tauri::image::Image;

const ICON_COLOR_NORMAL: &[u8] = include_bytes!("../../../icons/rclone_symbolic.png");
const ICON_COLOR_ACTIVE: &[u8] = include_bytes!("../../../icons/rclone_symbolic_active.png");

const ICON_MONO_LIGHT_NORMAL: &[u8] = include_bytes!("../../../icons/rclone_monochrome_light.png");
const ICON_MONO_LIGHT_ACTIVE: &[u8] =
    include_bytes!("../../../icons/rclone_monochrome_light_active.png");

const ICON_MONO_DARK_NORMAL: &[u8] = include_bytes!("../../../icons/rclone_monochrome_dark.png");
const ICON_MONO_DARK_ACTIVE: &[u8] =
    include_bytes!("../../../icons/rclone_monochrome_dark_active.png");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum TrayIconKind {
    ColorNormal = 0,
    ColorActive = 1,
    MonoLightNormal = 2,
    MonoLightActive = 3,
    MonoDarkNormal = 4,
    MonoDarkActive = 5,
}

impl TrayIconKind {
    #[must_use]
    pub fn resolve(is_active: bool, theme_style: &str) -> Self {
        match theme_style {
            "color" => {
                if is_active {
                    Self::ColorActive
                } else {
                    Self::ColorNormal
                }
            }
            "monochrome_light" => {
                if is_active {
                    Self::MonoLightActive
                } else {
                    Self::MonoLightNormal
                }
            }
            "monochrome_dark" => {
                if is_active {
                    Self::MonoDarkActive
                } else {
                    Self::MonoDarkNormal
                }
            }
            // "system" or fallback: auto-detect system theme
            _ => {
                let dark = is_system_dark();
                match (dark, is_active) {
                    (true, true) => Self::MonoLightActive,
                    (true, false) => Self::MonoLightNormal,
                    (false, true) => Self::MonoDarkActive,
                    (false, false) => Self::MonoDarkNormal,
                }
            }
        }
    }

    #[must_use]
    pub fn to_image(self) -> Image<'static> {
        static ICONS: std::sync::LazyLock<[Image<'static>; 6]> = std::sync::LazyLock::new(|| {
            [
                Image::from_bytes(ICON_COLOR_NORMAL).expect("embedded icon PNG is valid"),
                Image::from_bytes(ICON_COLOR_ACTIVE).expect("embedded icon PNG is valid"),
                Image::from_bytes(ICON_MONO_LIGHT_NORMAL).expect("embedded icon PNG is valid"),
                Image::from_bytes(ICON_MONO_LIGHT_ACTIVE).expect("embedded icon PNG is valid"),
                Image::from_bytes(ICON_MONO_DARK_NORMAL).expect("embedded icon PNG is valid"),
                Image::from_bytes(ICON_MONO_DARK_ACTIVE).expect("embedded icon PNG is valid"),
            ]
        });
        ICONS[self as usize].clone()
    }
}

pub(crate) fn is_system_dark() -> bool {
    #[cfg(not(feature = "web-server"))]
    {
        crate::utils::app::ui::is_system_dark()
    }
    #[cfg(feature = "web-server")]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tray_icon_kind_resolve_fixed_themes() {
        assert_eq!(
            TrayIconKind::resolve(false, "color"),
            TrayIconKind::ColorNormal
        );
        assert_eq!(
            TrayIconKind::resolve(true, "color"),
            TrayIconKind::ColorActive
        );
        assert_eq!(
            TrayIconKind::resolve(false, "monochrome_light"),
            TrayIconKind::MonoLightNormal
        );
        assert_eq!(
            TrayIconKind::resolve(true, "monochrome_light"),
            TrayIconKind::MonoLightActive
        );
        assert_eq!(
            TrayIconKind::resolve(false, "monochrome_dark"),
            TrayIconKind::MonoDarkNormal
        );
        assert_eq!(
            TrayIconKind::resolve(true, "monochrome_dark"),
            TrayIconKind::MonoDarkActive
        );
    }

    #[test]
    fn test_tray_icon_kind_to_image_valid() {
        for kind in [
            TrayIconKind::ColorNormal,
            TrayIconKind::ColorActive,
            TrayIconKind::MonoLightNormal,
            TrayIconKind::MonoLightActive,
            TrayIconKind::MonoDarkNormal,
            TrayIconKind::MonoDarkActive,
        ] {
            let img = kind.to_image();
            assert!(img.width() > 0);
            assert!(img.height() > 0);
        }
    }
}
