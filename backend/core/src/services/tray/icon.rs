//! Which tray icon shows; the host turns it into a native image.
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

    /// `system_dark` is the host's theme, used when the setting follows the system.
    #[must_use]
    pub fn resolve(is_active: bool, theme_style: &str, system_dark: bool) -> Self {
        let idle = match theme_style {
            "color" => Self::ColorNormal,
            "monochrome_light" => Self::MonoLightNormal,
            "monochrome_dark" => Self::MonoDarkNormal,
            // "system" or fallback: a dark panel needs the light icon
            _ if system_dark => Self::MonoLightNormal,
            _ => Self::MonoDarkNormal,
        };
        if is_active { idle.active() } else { idle }
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
            TrayIconKind::resolve(false, "color", false),
            TrayIconKind::ColorNormal
        );
        assert_eq!(
            TrayIconKind::resolve(true, "color", false),
            TrayIconKind::ColorActive
        );
        assert_eq!(
            TrayIconKind::resolve(false, "monochrome_light", false),
            TrayIconKind::MonoLightNormal
        );
        assert_eq!(
            TrayIconKind::resolve(true, "monochrome_light", true),
            TrayIconKind::MonoLightActive
        );
        assert_eq!(
            TrayIconKind::resolve(false, "monochrome_dark", true),
            TrayIconKind::MonoDarkNormal
        );
        assert_eq!(
            TrayIconKind::resolve(true, "monochrome_dark", false),
            TrayIconKind::MonoDarkActive
        );
    }

    #[test]
    fn the_system_theme_only_decides_when_the_setting_follows_it() {
        for theme in ["system", ""] {
            assert_eq!(
                TrayIconKind::resolve(false, theme, true),
                TrayIconKind::MonoLightNormal
            );
            assert_eq!(
                TrayIconKind::resolve(true, theme, false),
                TrayIconKind::MonoDarkActive
            );
        }
    }
}
