//! rcman-compatible settings schema for `RClone` Manager
//!
//! This module provides the `SettingsSchema` implementation for the existing
//! `AppSettings` types, using the derive macro for simplified definition.

use rcman::DeriveSettingsSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// List of supported BCP-47 language tags
// When adding a new language, add its BCP-47 code here, to the `options(...)` of
// `GeneralSettings::language` (a test keeps both in step) and create the translation file
const SUPPORTED_LANGUAGES: &[&str] = &[
    "en-US", "tr-TR", "es-ES", "zh-CN", "zh-TW", "fr-FR", "uk-UA", "ru-RU", "pt-BR", "ja-JP",
    "sk-SK",
];

// Struct Definitions with Derive Macro

/// General settings
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "general")]
pub struct GeneralSettings {
    #[setting(
        label = "settings.general.language.label",
        description = "settings.general.language.description",
        options(
            ("en-US", "English (US)"),
            ("tr-TR", "Türkçe (Türkiye)"),
            ("es-ES", "Español (España)"),
            ("zh-CN", "中文 (简体)"),
            ("zh-TW", "繁體中文 (台灣)"),
            ("fr-FR", "Français (France)"),
            ("uk-UA", "Українська (Україна)"),
            ("ru-RU", "Русский (Россия)"),
            ("ja-JP", "日本語 (日本)"),
            ("pt-BR", "Português (Brasil)"),
            ("sk-SK", "Slovenčina (Slovensko)")
        )
    )]
    pub language: String,

    #[setting(
        label = "settings.general.default_view.label",
        description = "settings.general.default_view.description",
        options(
            ("main_menu", "settings.general.default_view.options.main_menu"),
            ("nautilus", "settings.general.default_view.options.nautilus"),
            ("flow", "settings.general.default_view.options.flow")
        )
    )]
    pub default_view: String,

    #[setting(
        label = "settings.general.tray_enabled.label",
        description = "settings.general.tray_enabled.description"
    )]
    #[cfg(feature = "tray")]
    pub tray_enabled: bool,

    #[setting(
        label = "settings.general.tray_icon_theme.label",
        description = "settings.general.tray_icon_theme.description",
        options(
            ("system", "settings.general.tray_icon_theme.options.system"),
            ("color", "settings.general.tray_icon_theme.options.color"),
            ("monochrome_light", "settings.general.tray_icon_theme.options.monochrome_light"),
            ("monochrome_dark", "settings.general.tray_icon_theme.options.monochrome_dark")
        )
    )]
    #[cfg(feature = "tray")]
    pub tray_icon_theme: String,

    #[setting(
        label = "settings.general.start_on_startup.label",
        description = "settings.general.start_on_startup.description"
    )]
    #[cfg(all(
        any(feature = "autostart", feature = "flatpak"),
        not(any(target_os = "android", target_os = "ios"))
    ))]
    pub start_on_startup: bool,

    #[setting(
        label = "settings.general.notifications.label",
        description = "settings.general.notifications.description"
    )]
    #[cfg(feature = "notifications")]
    pub notifications: bool,

    #[setting(
        label = "settings.general.restrict.label",
        description = "settings.general.restrict.description"
    )]
    pub restrict: bool,

    #[setting(
        label = "settings.general.standalone_dialogs.label",
        description = "settings.general.standalone_dialogs.description"
    )]
    #[cfg(all(desktop, any(feature = "desktop", feature = "mobile")))]
    pub standalone_dialogs: bool,

    #[setting(
        label = "settings.general.system_accent_color.label",
        description = "settings.general.system_accent_color.description"
    )]
    #[cfg(all(
        feature = "desktop",
        any(target_os = "linux", windows, target_os = "macos")
    ))]
    pub system_accent_color: bool,

    #[setting(
        label = "settings.general.prevent_sleep.label",
        description = "settings.general.prevent_sleep.description"
    )]
    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    pub prevent_sleep: bool,

    #[setting(
        label = "settings.general.ui_scale.label",
        description = "settings.general.ui_scale.description",
        min = 50,
        max = 200,
        step = 10
    )]
    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    pub ui_scale: u32,

    #[setting(
        label = "settings.general.keep_alive.label",
        description = "settings.general.keep_alive.description"
    )]
    #[cfg(target_os = "android")]
    pub keep_alive: bool,

    #[setting(
        label = "settings.general.start_on_boot.label",
        description = "settings.general.start_on_boot.description"
    )]
    #[cfg(target_os = "android")]
    pub start_on_boot: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        let system_locale = sys_locale::get_locale().unwrap_or_else(|| "en-US".to_string());

        let language = if SUPPORTED_LANGUAGES.contains(&system_locale.as_str()) {
            system_locale
        } else {
            "en-US".to_string()
        };

        Self {
            #[cfg(feature = "tray")]
            tray_enabled: true,
            #[cfg(feature = "tray")]
            tray_icon_theme: "color".to_string(),
            #[cfg(feature = "notifications")]
            notifications: true,
            #[cfg(all(
                any(feature = "autostart", feature = "flatpak"),
                not(any(target_os = "android", target_os = "ios"))
            ))]
            start_on_startup: false,
            #[cfg(all(desktop, any(feature = "desktop", feature = "mobile")))]
            standalone_dialogs: false,
            #[cfg(all(
                feature = "desktop",
                any(target_os = "linux", windows, target_os = "macos")
            ))]
            system_accent_color: true,
            #[cfg(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))]
            prevent_sleep: true,
            #[cfg(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))]
            ui_scale: 100,
            #[cfg(target_os = "android")]
            keep_alive: true,
            #[cfg(target_os = "android")]
            start_on_boot: false,
            language,
            default_view: "main_menu".to_string(),
            restrict: true,
        }
    }
}

/// Core settings
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "core")]
#[cfg_attr(
    all(
        feature = "librclone",
        not(feature = "tray"),
        any(target_os = "android", target_os = "ios")
    ),
    derive(Default)
)]
pub struct CoreSettings {
    #[setting(
        label = "settings.core.max_tray_items.label",
        description = "settings.core.max_tray_items.description",
        min = 1,
        max = 40,
        step = 1
    )]
    #[cfg(feature = "tray")]
    pub max_tray_items: usize,

    #[setting(
        label = "settings.core.rclone_binary.label",
        description = "settings.core.rclone_binary.description",
        engine_restart = true
    )]
    #[cfg(not(feature = "librclone"))]
    pub rclone_binary: String,

    #[setting(
        label = "settings.core.rclone_flags.label",
        description = "settings.core.rclone_flags.description",
        engine_restart = true,
        reserved(
            "rcd",
            "--config",
            "--rc",
            "--rc-serve",
            "--rc-addr",
            "--rc-allow-origin",
            "--log-file",
            "--rc-user",
            "--rc-pass",
            "--rc-no-auth",
            "--rc-template",
            "--log-file-max-size",
            "--log-file-max-backups",
        )
    )]
    #[cfg(not(feature = "librclone"))]
    pub rclone_additional_flags: Vec<String>,

    #[setting(
        label = "settings.core.rclone_env_vars.label",
        description = "settings.core.rclone_env_vars.description",
        engine_restart = true
    )]
    #[cfg(not(feature = "librclone"))]
    pub rclone_env_vars: Vec<String>,

    #[setting(
        label = "settings.core.connection_check_urls.label",
        description = "settings.core.connection_check_urls.description"
    )]
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub connection_check_urls: Vec<String>,

    #[setting(
        label = "settings.core.bandwidth_limit.label",
        description = "settings.core.bandwidth_limit.description",
        placeholder = "settings.core.bandwidth_limit.placeholder"
    )]
    pub bandwidth_limit: String,

    #[setting(
        label = "settings.core.completed_onboarding.label",
        description = "settings.core.completed_onboarding.description"
    )]
    pub completed_onboarding: bool,

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[setting(
        label = "settings.core.skip_mount_plugin_check.label",
        description = "settings.core.skip_mount_plugin_check.description"
    )]
    pub skip_mount_plugin_check: bool,
}

#[cfg(not(all(
    feature = "librclone",
    not(feature = "tray"),
    any(target_os = "android", target_os = "ios")
)))]
impl Default for CoreSettings {
    fn default() -> Self {
        Self {
            #[cfg(feature = "tray")]
            max_tray_items: 5,
            #[cfg(not(feature = "librclone"))]
            rclone_binary: String::new(),
            #[cfg(not(feature = "librclone"))]
            rclone_additional_flags: vec![],
            #[cfg(not(feature = "librclone"))]
            rclone_env_vars: vec![],
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            connection_check_urls: vec![
                "https://www.google.com".to_string(),
                "https://www.dropbox.com".to_string(),
                "https://onedrive.live.com".to_string(),
            ],
            bandwidth_limit: String::new(),
            completed_onboarding: false,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            skip_mount_plugin_check: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "developer")]
pub struct DeveloperSettings {
    #[setting(
        label = "settings.developer.log_level.label",
        description = "settings.developer.log_level.description",
        options(
            ("error", "settings.developer.log_level.options.error"),
            ("warn", "settings.developer.log_level.options.warn"),
            ("info", "settings.developer.log_level.options.info"),
            ("debug", "settings.developer.log_level.options.debug"),
            ("trace", "settings.developer.log_level.options.trace")
        ),
    )]
    pub log_level: String,

    #[setting(
        label = "settings.developer.destroy_window_on_close.label",
        description = "settings.developer.destroy_window_on_close.description"
    )]
    #[cfg(all(desktop, any(feature = "desktop", feature = "mobile")))]
    pub destroy_window_on_close: bool,
}

impl Default for DeveloperSettings {
    fn default() -> Self {
        Self {
            log_level: "info".to_string(),
            #[cfg(all(desktop, any(feature = "desktop", feature = "mobile")))]
            destroy_window_on_close: true,
        }
    }
}

/// The "What do you want to do?" setup guide
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "wizard")]
pub struct WizardSettings {
    #[setting(
        label = "settings.wizard.after_remote.label",
        description = "settings.wizard.after_remote.description"
    )]
    pub after_remote: bool,

    #[setting(
        label = "settings.wizard.destination.label",
        description = "settings.wizard.destination.description",
        options(
            ("auto", "settings.wizard.destination.options.auto"),
            ("quick_run", "settings.wizard.destination.options.quick_run"),
            ("profile", "settings.wizard.destination.options.profile")
        )
    )]
    pub destination: String,
}

impl Default for WizardSettings {
    fn default() -> Self {
        Self {
            after_remote: true,
            destination: "auto".to_string(),
        }
    }
}

/// Runtime settings
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "runtime")]
pub struct RuntimeSettings {
    #[setting(label = "settings.runtime.theme.label", options(("system", "settings.runtime.theme.options.system"), ("light", "settings.runtime.theme.options.light"), ("dark", "settings.runtime.theme.options.dark")))]
    pub theme: String,

    #[setting(
        label = "settings.runtime.app_auto_check_updates.label",
        description = "settings.runtime.app_auto_check_updates.description"
    )]
    pub app_auto_check_updates: bool,

    #[setting(
        label = "settings.runtime.app_skipped_updates.label",
        description = "settings.runtime.app_skipped_updates.description"
    )]
    pub app_skipped_updates: Vec<String>,

    #[setting(label = "settings.runtime.app_update_channel.label", options(("stable", "settings.runtime.app_update_channel.options.stable"), ("beta", "settings.runtime.app_update_channel.options.beta")))]
    pub app_update_channel: String,

    #[setting(
        label = "settings.runtime.rclone_auto_check_updates.label",
        description = "settings.runtime.rclone_auto_check_updates.description"
    )]
    #[cfg(not(feature = "librclone"))]
    pub rclone_auto_check_updates: bool,

    #[setting(
        label = "settings.runtime.rclone_skipped_updates.label",
        description = "settings.runtime.rclone_skipped_updates.description"
    )]
    #[cfg(not(feature = "librclone"))]
    pub rclone_skipped_updates: Vec<String>,

    #[setting(label = "settings.runtime.rclone_update_channel.label", options(("stable", "settings.runtime.rclone_update_channel.options.stable"), ("beta", "settings.runtime.rclone_update_channel.options.beta")))]
    #[cfg(not(feature = "librclone"))]
    pub rclone_update_channel: String,

    #[setting(label = "settings.runtime.flatpak_warn.label")]
    #[cfg(feature = "flatpak")]
    pub flatpak_warn: bool,

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[setting(
        label = "settings.runtime.mount_warn.label",
        description = "settings.runtime.mount_warn.description"
    )]
    pub mount_warn: bool,

    #[setting(
        label = "settings.runtime.dashboard_layout.label",
        description = "settings.runtime.dashboard_layout.description"
    )]
    pub dashboard_layout: Value,

    #[setting(
        label = "settings.runtime.quick_run_layout.label",
        description = "settings.runtime.quick_run_layout.description"
    )]
    pub quick_run_layout: Value,

    #[setting(
        label = "settings.runtime.remote_layouts.label",
        description = "settings.runtime.remote_layouts.description"
    )]
    pub remote_layouts: Value,

    #[setting(
        label = "settings.runtime.dashboard_card_variant.label",
        description = "settings.runtime.dashboard_card_variant.description",
        options(("compact", "settings.runtime.dashboard_card_variant.options.compact"), ("detailed", "settings.runtime.dashboard_card_variant.options.detailed"))
    )]
    pub dashboard_card_variant: String,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            app_auto_check_updates: true,
            app_skipped_updates: vec![],
            app_update_channel: "stable".to_string(),
            #[cfg(not(feature = "librclone"))]
            rclone_auto_check_updates: true,
            #[cfg(not(feature = "librclone"))]
            rclone_skipped_updates: vec![],
            #[cfg(not(feature = "librclone"))]
            rclone_update_channel: "stable".to_string(),
            #[cfg(feature = "flatpak")]
            flatpak_warn: true,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            mount_warn: true,
            dashboard_layout: Value::Object(Default::default()),
            quick_run_layout: Value::Object(Default::default()),
            remote_layouts: Value::Object(Default::default()),
            dashboard_card_variant: "compact".to_string(),
        }
    }
}

/// The file browser's settings. Its preferences are shown on the preferences
/// window's File Browser tab; the data it keeps (starred items, bookmarks and what
/// the toolbar and sidebar change) is marked `hidden` and stays off that tab.
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "nautilus")]
pub struct NautilusSettings {
    #[setting(
        label = "settings.nautilus.layout.label",
        description = "settings.nautilus.layout.description",
        options(
            ("grid", "settings.nautilus.layout.options.grid"),
            ("list", "settings.nautilus.layout.options.list")
        )
    )]
    pub layout: String,

    /// A column and a direction, named and labelled as in the file browser's sort menu.
    #[setting(
        label = "settings.nautilus.sort.label",
        description = "settings.nautilus.sort.description",
        options(
            ("name-asc", "nautilus.sort.az"),
            ("name-desc", "nautilus.sort.za"),
            ("modified-desc", "nautilus.sort.lastModified"),
            ("modified-asc", "nautilus.sort.firstModified"),
            ("size-desc", "nautilus.sort.sizeLargest"),
            ("size-asc", "nautilus.sort.sizeSmallest")
        )
    )]
    pub sort: String,

    #[setting(
        label = "settings.nautilus.show_hidden.label",
        description = "settings.nautilus.show_hidden.description"
    )]
    pub show_hidden: bool,

    #[setting(
        label = "settings.nautilus.ask_transfer_options.label",
        description = "settings.nautilus.ask_transfer_options.description"
    )]
    pub ask_transfer_options: bool,

    /// Uploads from the web interface are sent in requests no larger than this,
    /// so they pass a proxy that limits a request's body (nginx: 1 MiB by default).
    /// The server writes a chunk to disk as it arrives, so the size costs it no
    /// memory; larger chunks help a single large file over a fast, distant link.
    #[setting(
        label = "settings.nautilus.upload_request_mib.label",
        description = "settings.nautilus.upload_request_mib.description",
        min = 1,
        step = 1
    )]
    #[cfg(not(any(feature = "desktop", feature = "mobile")))]
    pub upload_request_mib: u32,

    #[setting(
        label = "settings.nautilus.parallel_uploads.label",
        description = "settings.nautilus.parallel_uploads.description",
        min = 1,
        step = 1
    )]
    #[cfg(not(any(feature = "desktop", feature = "mobile")))]
    pub parallel_uploads: u32,

    /// The options every copy, move and upload of the file browser runs with unless its
    /// dialog sets others: `copy`, `move`, `filter` and `backend`, each a map of options.
    #[setting(hidden = true)]
    pub transfer_options: Value,

    #[setting(hidden = true)]
    pub starred: Vec<Value>,

    #[setting(hidden = true)]
    pub bookmarks: Vec<Value>,

    /// Pixels, one of the sizes the toolbar offers for each layout.
    #[setting(hidden = true)]
    pub grid_icon_size: u32,

    #[setting(hidden = true)]
    pub list_icon_size: u32,

    #[setting(hidden = true)]
    pub sidebar_drive_order: Vec<String>,

    #[setting(hidden = true)]
    pub sidebar_hidden_drives: Vec<String>,
}

impl Default for NautilusSettings {
    fn default() -> Self {
        Self {
            layout: "grid".to_string(),
            sort: "name-asc".to_string(),
            show_hidden: false,
            ask_transfer_options: false,
            #[cfg(not(any(feature = "desktop", feature = "mobile")))]
            upload_request_mib: 8,
            #[cfg(not(any(feature = "desktop", feature = "mobile")))]
            parallel_uploads: 3,
            transfer_options: Value::Object(Default::default()),
            starred: Vec::new(),
            bookmarks: Vec::new(),
            grid_icon_size: 96,
            list_icon_size: 24,
            sidebar_drive_order: Vec::new(),
            sidebar_hidden_drives: Vec::new(),
        }
    }
}

// Main AppSettings - Uses nested struct flattening

/// The complete settings model
#[derive(Debug, Serialize, Deserialize, Clone, Default, DeriveSettingsSchema)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub core: CoreSettings,
    pub developer: DeveloperSettings,
    pub wizard: WizardSettings,
    pub runtime: RuntimeSettings,
    pub nautilus: NautilusSettings,
}

/// User preset template schema for `rcman`
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "templates")]
pub struct UserPresetTemplate {
    #[setting(label = "templates.id.label", description = "templates.id.description")]
    pub id: String,

    #[setting(
        label = "templates.name.label",
        description = "templates.name.description"
    )]
    pub name: String,

    #[setting(
        label = "templates.description.label",
        description = "templates.description.description"
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[setting(
        label = "templates.values.label",
        description = "templates.values.description"
    )]
    #[serde(default)]
    pub values: Value,
}

impl Default for UserPresetTemplate {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: None,
            values: Value::Object(Default::default()),
        }
    }
}

#[cfg(test)]
mod feature_tests {
    use super::GeneralSettings;
    use rcman::SettingsSchema;

    // The derive attribute needs literals, so the language list exists twice.
    #[test]
    fn supported_languages_match_the_language_options() {
        let metadata = GeneralSettings::get_metadata();
        let mut offered: Vec<String> = metadata["general.language"]
            .constraints
            .options
            .as_ref()
            .expect("language is a select setting")
            .iter()
            .map(|option| option.value.as_str().unwrap().to_owned())
            .collect();
        let mut supported: Vec<String> = super::SUPPORTED_LANGUAGES
            .iter()
            .map(|language| (*language).to_owned())
            .collect();
        offered.sort();
        supported.sort();
        assert_eq!(offered, supported);
    }

    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    #[test]
    fn interface_scale_defaults_to_100_and_reads_older_settings_files() {
        let metadata = GeneralSettings::get_metadata();
        let scale = &metadata["general.ui_scale"].constraints.number;
        assert_eq!(
            (scale.min, scale.max, scale.step),
            (Some(50.0), Some(200.0), Some(10.0))
        );
        assert_eq!(GeneralSettings::default().ui_scale, 100);

        // A settings file saved before the setting existed.
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("settings.json"),
            r#"{"general": {"language": "en-US", "restrict": false}}"#,
        )
        .unwrap();
        let manager = rcman::SettingsManager::builder("ui-scale", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<super::AppSettings>()
            .build()
            .unwrap();
        assert_eq!(manager.get::<u32>("general.ui_scale").unwrap(), 100);
        assert!(!manager.get::<bool>("general.restrict").unwrap());
    }

    // The setup guide reads these three values, so the options and the defaults are fixed.
    #[test]
    fn wizard_settings_offer_what_the_guide_reads_and_default_on_older_files() {
        use super::WizardSettings;
        let metadata = WizardSettings::get_metadata();
        let options: Vec<&str> = metadata["wizard.destination"]
            .constraints
            .options
            .as_ref()
            .expect("destination is a select setting")
            .iter()
            .map(|option| option.value.as_str().unwrap())
            .collect();
        assert_eq!(options, ["auto", "quick_run", "profile"]);

        // A settings file saved before the category existed.
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("settings.json"),
            r#"{"general": {"language": "en-US", "restrict": false}}"#,
        )
        .unwrap();
        let manager = rcman::SettingsManager::builder("wizard", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<super::AppSettings>()
            .build()
            .unwrap();
        assert!(manager.get::<bool>("wizard.after_remote").unwrap());
        assert_eq!(manager.get::<String>("wizard.destination").unwrap(), "auto");
    }

    #[test]
    fn file_browser_view_settings_default_on_older_files_and_data_stays_hidden() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("settings.json"),
            r#"{"nautilus": {"starred": [], "bookmarks": []}}"#,
        )
        .unwrap();
        let manager = rcman::SettingsManager::builder("file-browser-view", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<super::AppSettings>()
            .build()
            .unwrap();
        assert_eq!(manager.get::<String>("nautilus.layout").unwrap(), "grid");
        assert_eq!(manager.get::<String>("nautilus.sort").unwrap(), "name-asc");
        assert!(!manager.get::<bool>("nautilus.show_hidden").unwrap());
        assert_eq!(manager.get::<u32>("nautilus.grid_icon_size").unwrap(), 96);
        assert_eq!(manager.get::<u32>("nautilus.list_icon_size").unwrap(), 24);
        assert!(
            manager
                .get::<Vec<String>>("nautilus.sidebar_hidden_drives")
                .unwrap()
                .is_empty()
        );
        let metadata = super::NautilusSettings::get_metadata();
        let options = metadata["nautilus.sort"].constraints.options.as_ref();
        assert_eq!(options.map(Vec::len), Some(6));
        // The preferences window shows every setting of the category that is not hidden,
        // so each of those needs a label, and the data the file browser keeps stays off it.
        for (key, setting) in &metadata {
            let hidden = setting.metadata.get("hidden") == Some(&serde_json::Value::Bool(true));
            assert_ne!(hidden, setting.metadata.contains_key("label"), "{key}");
        }
        for key in [
            "starred",
            "bookmarks",
            "grid_icon_size",
            "sidebar_drive_order",
        ] {
            assert!(
                metadata[&format!("nautilus.{key}")]
                    .metadata
                    .contains_key("hidden")
            );
        }
    }

    // The web interface sizes its upload requests from these.
    #[cfg(not(any(feature = "desktop", feature = "mobile")))]
    #[test]
    fn upload_settings_stay_within_what_the_server_takes_and_default_on_older_files() {
        let metadata = super::NautilusSettings::get_metadata();
        // Only values that cannot work are refused; how much is too much is the user's call.
        for (key, default) in [
            ("nautilus.upload_request_mib", 8),
            ("nautilus.parallel_uploads", 3),
        ] {
            let number = &metadata[key].constraints.number;
            assert_eq!((number.min, number.max), (Some(1.0), None), "{key}");
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(
                directory.path().join("settings.json"),
                r#"{"general": {"language": "en-US", "restrict": false}}"#,
            )
            .unwrap();
            let manager = rcman::SettingsManager::builder("file-browser", "1.0.0")
                .with_config_dir(directory.path())
                .with_schema::<super::AppSettings>()
                .build()
                .unwrap();
            assert_eq!(manager.get::<u32>(key).unwrap(), default, "{key}");
        }
    }

    #[test]
    fn settings_expose_only_enabled_integrations() {
        let settings = serde_json::to_value(GeneralSettings::default()).unwrap();
        assert_eq!(
            settings.get("standalone_dialogs").is_some(),
            cfg!(all(desktop, any(feature = "desktop", feature = "mobile")))
        );
        let developer = serde_json::to_value(super::DeveloperSettings::default()).unwrap();
        assert_eq!(
            developer.get("destroy_window_on_close").is_some(),
            cfg!(all(desktop, any(feature = "desktop", feature = "mobile")))
        );
        assert_eq!(
            settings.get("notifications").is_some(),
            cfg!(feature = "notifications")
        );
        assert_eq!(
            settings.get("tray_enabled").is_some(),
            cfg!(feature = "tray")
        );
        assert_eq!(
            settings.get("ui_scale").is_some(),
            cfg!(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))
        );
        assert_eq!(
            settings.get("prevent_sleep").is_some(),
            cfg!(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))
        );
        assert_eq!(
            settings.get("start_on_startup").is_some(),
            cfg!(all(
                any(feature = "autostart", feature = "flatpak"),
                not(any(target_os = "android", target_os = "ios"))
            ))
        );
        assert_eq!(
            settings.get("system_accent_color"),
            cfg!(all(
                feature = "desktop",
                any(target_os = "linux", windows, target_os = "macos")
            ))
            .then_some(&serde_json::Value::Bool(true))
        );
    }
}
