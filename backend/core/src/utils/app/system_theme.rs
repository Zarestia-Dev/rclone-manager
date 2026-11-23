//! The system's light or dark theme, read from the places each desktop keeps it.
//! The desktop app also follows changes; the server reads it once, for the tray.

/// Whether the system theme is dark, or `None` when no source answers.
#[must_use]
pub fn detect() -> Option<bool> {
    detect_platform_theme()
}

// ---------------------------------------------------------------------------
// Linux
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

// ---------------------------------------------------------------------------
// Windows
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
// macOS
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
}
