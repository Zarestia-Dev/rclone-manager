//! rcman-compatible settings schema for RClone Manager
//!
//! This module provides the SettingsSchema implementation for the existing
//! AppSettings types, using the derive macro for simplified definition.

use rcman::DeriveSettingsSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// List of supported BCP-47 language tags
// When adding a new language, add its BCP-47 code here and create the translation file
const SUPPORTED_LANGUAGES: &[&str] = &["en-US", "tr-TR", "es-ES", "zh-CN"];

// =============================================================================
// Struct Definitions with Derive Macro
// =============================================================================

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
            ("zh-CN", "中文 (简体)")
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
    pub notifications: bool,

    #[setting(
        label = "settings.general.restrict.label",
        description = "settings.general.restrict.description"
    )]
    pub restrict: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        let system_locale = tauri_plugin_os::locale().unwrap_or_else(|| "en-US".to_string());

        let language = if SUPPORTED_LANGUAGES.contains(&system_locale.as_str()) {
            system_locale
        } else {
            "en-US".to_string()
        };

        Self {
            #[cfg(feature = "tray")]
            tray_enabled: true,
            language,
            start_on_startup: false,
            notifications: true,
            restrict: true,
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
        label = "settings.core.rclone_path.label",
        description = "settings.core.rclone_path.description",
        engine_restart = true
    )]
    pub rclone_path: String,

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
            rclone_path: String::new(),
            rclone_additional_flags: vec![],
            rclone_env_vars: vec![],
            completed_onboarding: false,
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
    pub rclone_auto_check_updates: bool,

    #[setting(
        label = "settings.runtime.rclone_skipped_updates.label",
        description = "settings.runtime.rclone_skipped_updates.description"
    )]
    pub rclone_skipped_updates: Vec<String>,

    #[setting(label = "settings.runtime.rclone_update_channel.label", options(("stable", "settings.runtime.rclone_update_channel.options.stable"), ("beta", "settings.runtime.rclone_update_channel.options.beta")))]
    pub rclone_update_channel: String,

    #[setting(label = "settings.runtime.flatpak_warn.label")]
    pub flatpak_warn: bool,

    #[setting(
        label = "settings.runtime.dashboard_layout.label",
        description = "settings.runtime.dashboard_layout.description"
    )]
    pub dashboard_layout: Vec<String>,

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
            rclone_auto_check_updates: true,
            rclone_skipped_updates: vec![],
            rclone_update_channel: "stable".to_string(),
            flatpak_warn: true,
            dashboard_layout: vec![],
            dashboard_card_variant: "compact".to_string(),
        }
    }
}

/// Nautilus (file browser) specific preferences
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "nautilus")]
pub struct NautilusSettings {
    #[setting(label = "settings.nautilus.default_layout.label", description = "settings.nautilus.default_layout.description", options(("grid", "settings.nautilus.default_layout.options.grid"), ("list", "settings.nautilus.default_layout.options.list")))]
    pub default_layout: String,

    #[setting(
        label = "settings.nautilus.grid_icon_size.label",
        description = "settings.nautilus.grid_icon_size.description",
        min = 16,
        max = 512
    )]
    pub grid_icon_size: i32,

    #[setting(
        label = "settings.nautilus.list_icon_size.label",
        description = "settings.nautilus.list_icon_size.description",
        min = 16,
        max = 256
    )]
    pub list_icon_size: i32,

    #[setting(
        label = "settings.nautilus.show_hidden_items.label",
        description = "settings.nautilus.show_hidden_items.description"
    )]
    pub show_hidden_items: bool,

    #[setting(label = "settings.nautilus.sort_key.label", options(
        ("name-asc", "settings.nautilus.sort_key.options.name-asc"),
        ("name-desc", "settings.nautilus.sort_key.options.name-desc"),
        ("size-asc", "settings.nautilus.sort_key.options.size-asc"),
        ("size-desc", "settings.nautilus.sort_key.options.size-desc"),
        ("date-asc", "settings.nautilus.sort_key.options.date-asc"),
        ("date-desc", "settings.nautilus.sort_key.options.date-desc")
    ))]
    pub sort_key: String,

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

    #[setting(
        label = "settings.nautilus.split_divider_pos.label",
        description = "settings.nautilus.split_divider_pos.description",
        min = 10,
        max = 90
    )]
    pub split_divider_pos: i32,
}

impl Default for NautilusSettings {
    fn default() -> Self {
        Self {
            default_layout: "grid".to_string(),
            grid_icon_size: 96,
            list_icon_size: 32,
            show_hidden_items: false,
            sort_key: "name-asc".to_string(),
            starred: vec![],
            bookmarks: vec![],
            split_divider_pos: 50,
        }
    }
}

// =============================================================================
// Main AppSettings - Uses nested struct flattening
// =============================================================================

/// The complete settings model
#[derive(Debug, Serialize, Deserialize, Clone, Default, DeriveSettingsSchema)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub core: CoreSettings,
    pub developer: DeveloperSettings,
    pub runtime: RuntimeSettings,
    pub nautilus: NautilusSettings,
}
