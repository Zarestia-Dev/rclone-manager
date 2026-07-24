//! rcman-compatible settings schema for `RClone` Manager
//!
//! This module provides the `SettingsSchema` implementation for the existing
//! `AppSettings` types, using the derive macro for simplified definition.

use rcman::DeriveSettingsSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// List of supported BCP-47 language tags
// When adding a new language, add its BCP-47 code here and create the translation file
const SUPPORTED_LANGUAGES: &[&str] = &[
    "en-US", "tr-TR", "es-ES", "zh-CN", "fr-FR", "uk-UA", "ru-RU",
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
            ("fr-FR", "Français (France)"),
            ("uk-UA", "Українська (Україна)"),
            ("ru-RU", "Русский (Россия)")
        )
    )]
    pub language: String,

    #[setting(
        label = "settings.general.tray_enabled.label",
        description = "settings.general.tray_enabled.description"
    )]
    #[cfg(feature = "tray")]
    pub tray_enabled: bool,

    #[setting(
        label = "settings.general.start_on_startup.label",
        description = "settings.general.start_on_startup.description"
    )]
    pub start_on_startup: bool,

    #[setting(
        label = "settings.general.notifications.label",
        description = "settings.general.notifications.description"
    )]
    #[cfg(feature = "tauri-plugin-notification")]
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
    #[cfg(all(desktop, not(feature = "web-server")))]
    pub standalone_dialogs: bool,
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
            #[cfg(feature = "tauri-plugin-notification")]
            notifications: true,
            language,
            start_on_startup: false,
            restrict: true,
            #[cfg(all(desktop, not(feature = "web-server")))]
            standalone_dialogs: false,
        }
    }
}

/// Core settings
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "core")]
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
        label = "settings.core.connection_check_urls.label",
        description = "settings.core.connection_check_urls.description"
    )]
    pub connection_check_urls: Vec<String>,

    #[setting(
        label = "settings.core.rclone_binary.label",
        description = "settings.core.rclone_binary.description",
        engine_restart = true
    )]
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
    pub rclone_additional_flags: Vec<String>,

    #[setting(
        label = "settings.core.bandwidth_limit.label",
        description = "settings.core.bandwidth_limit.description",
        placeholder = "settings.core.bandwidth_limit.placeholder"
    )]
    pub bandwidth_limit: String,

    #[setting(
        label = "settings.core.rclone_env_vars.label",
        description = "settings.core.rclone_env_vars.description",
        engine_restart = true
    )]
    pub rclone_env_vars: Vec<String>,

    #[setting(
        label = "settings.core.completed_onboarding.label",
        description = "settings.core.completed_onboarding.description"
    )]
    pub completed_onboarding: bool,

    #[setting(
        label = "settings.core.default_mount_directory.label",
        description = "settings.core.default_mount_directory.description"
    )]
    pub default_mount_directory: String,
}

impl Default for CoreSettings {
    fn default() -> Self {
        Self {
            #[cfg(feature = "tray")]
            max_tray_items: 5,
            connection_check_urls: vec![
                "https://www.google.com".to_string(),
                "https://www.dropbox.com".to_string(),
                "https://onedrive.live.com".to_string(),
            ],
            bandwidth_limit: String::new(),
            rclone_binary: String::new(),
            rclone_additional_flags: vec![],
            rclone_env_vars: vec![],
            completed_onboarding: false,
            default_mount_directory: "{home}/rclone-manager/{remote}".to_string(),
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
    #[cfg(not(feature = "web-server"))]
    pub destroy_window_on_close: bool,
}

impl Default for DeveloperSettings {
    fn default() -> Self {
        Self {
            log_level: "info".to_string(),
            #[cfg(not(feature = "web-server"))]
            destroy_window_on_close: true,
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
    #[cfg(feature = "updater")]
    pub app_auto_check_updates: bool,

    #[setting(
        label = "settings.runtime.app_skipped_updates.label",
        description = "settings.runtime.app_skipped_updates.description"
    )]
    #[cfg(feature = "updater")]
    pub app_skipped_updates: Vec<String>,

    #[setting(label = "settings.runtime.app_update_channel.label", options(("stable", "settings.runtime.app_update_channel.options.stable"), ("beta", "settings.runtime.app_update_channel.options.beta")))]
    #[cfg(feature = "updater")]
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

    #[setting(
        label = "settings.runtime.dashboard_layout.label",
        description = "settings.runtime.dashboard_layout.description"
    )]
    pub dashboard_layout: Value,

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
            #[cfg(feature = "updater")]
            app_auto_check_updates: true,
            #[cfg(feature = "updater")]
            app_skipped_updates: vec![],
            #[cfg(feature = "updater")]
            app_update_channel: "stable".to_string(),
            #[cfg(not(feature = "librclone"))]
            rclone_auto_check_updates: true,
            #[cfg(not(feature = "librclone"))]
            rclone_skipped_updates: vec![],
            #[cfg(not(feature = "librclone"))]
            rclone_update_channel: "stable".to_string(),
            #[cfg(feature = "flatpak")]
            flatpak_warn: true,
            dashboard_layout: Value::Object(Default::default()),
            remote_layouts: Value::Object(Default::default()),
            dashboard_card_variant: "compact".to_string(),
        }
    }
}

/// Nautilus (file browser) specific preferences
#[derive(Debug, Serialize, Deserialize, Clone, Default, DeriveSettingsSchema)]
#[schema(category = "nautilus")]
pub struct NautilusSettings {
    #[setting(
        label = "settings.nautilus.starred.label",
        description = "settings.nautilus.starred.description"
    )]
    pub starred: Vec<Value>,

    #[setting(
        label = "settings.nautilus.bookmarks.label",
        description = "settings.nautilus.bookmarks.description"
    )]
    pub bookmarks: Vec<Value>,
}

// Main AppSettings - Uses nested struct flattening

/// The complete settings model
#[derive(Debug, Serialize, Deserialize, Clone, Default, DeriveSettingsSchema)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub core: CoreSettings,
    pub developer: DeveloperSettings,
    pub runtime: RuntimeSettings,
    pub nautilus: NautilusSettings,
}
