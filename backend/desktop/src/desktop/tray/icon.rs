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
    pub fn inactive(self) -> Self {
        match self {
            Self::ColorNormal | Self::ColorActive => Self::ColorNormal,
            Self::MonoLightNormal | Self::MonoLightActive => Self::MonoLightNormal,
            Self::MonoDarkNormal | Self::MonoDarkActive => Self::MonoDarkNormal,
        }
    }

    #[must_use]
    pub fn active(self) -> Self {
        match self {
            Self::ColorNormal | Self::ColorActive => Self::ColorActive,
            Self::MonoLightNormal | Self::MonoLightActive => Self::MonoLightActive,
            Self::MonoDarkNormal | Self::MonoDarkActive => Self::MonoDarkActive,
        }
    }

    #[must_use]
    pub fn resolve(is_active: bool, theme_style: &str) -> Self {
        let idle = match theme_style {
            "color" => Self::ColorNormal,
            "monochrome_light" => Self::MonoLightNormal,
            "monochrome_dark" => Self::MonoDarkNormal,
            // "system" or fallback: a dark panel needs the light icon
            _ if crate::native::theme::is_system_dark() => Self::MonoLightNormal,
            _ => Self::MonoDarkNormal,
        };
        if is_active { idle.active() } else { idle }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_icons_preserve_the_theme_without_disclosing_activity() {
        for (active, normal) in [
            (TrayIconKind::ColorActive, TrayIconKind::ColorNormal),
            (TrayIconKind::MonoLightActive, TrayIconKind::MonoLightNormal),
            (TrayIconKind::MonoDarkActive, TrayIconKind::MonoDarkNormal),
        ] {
            assert_eq!(active.inactive(), normal);
            assert_eq!(normal.inactive(), normal);
        }
    }

    #[test]
    fn active_icons_keep_the_theme() {
        assert_eq!(
            TrayIconKind::ColorNormal.active(),
            TrayIconKind::ColorActive
        );
        assert_eq!(
            TrayIconKind::MonoLightActive.active(),
            TrayIconKind::MonoLightActive
        );
        assert_eq!(
            TrayIconKind::MonoDarkNormal.active(),
            TrayIconKind::MonoDarkActive
        );
    }

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
