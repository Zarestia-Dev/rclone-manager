//! rcman-compatible settings schema for RClone Manager
//!
//! This module provides the SettingsSchema implementation for the existing
//! AppSettings types, enabling integration with rcman's SettingsManager.
//! It also holds the struct definitions which were migrated from the legacy settings module.

use rcman::{SettingMetadata as RcmanSettingMetadata, SettingsSchema, opt, settings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// =============================================================================
// Struct Definitions (Migrated from legacy settings.rs)
// =============================================================================

/// General settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeneralSettings {
    pub tray_enabled: bool,
    pub start_on_startup: bool,
    pub notifications: bool,
    pub restrict: bool,
}

/// Core settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CoreSettings {
    pub max_tray_items: usize,
    pub rclone_api_port: u16,
    pub rclone_oauth_port: u16,
    pub connection_check_urls: Vec<String>,
    pub rclone_config_file: String,
    pub rclone_path: String,
    pub bandwidth_limit: String,
    pub completed_onboarding: bool,
    pub terminal_apps: Vec<String>,
}

/// Developer settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeveloperSettings {
    pub debug_logging: bool,
    pub destroy_window_on_close: bool,
}

/// Runtime settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuntimeSettings {
    pub theme: String,
    pub app_auto_check_updates: bool,
    pub app_skipped_updates: Vec<String>,
    pub app_update_channel: String,
    pub rclone_auto_check_updates: bool,
    pub rclone_skipped_updates: Vec<String>,
    pub rclone_update_channel: String,
    pub flatpak_warn: bool,
    pub dashboard_layout: Option<Vec<String>>,
}

/// Nautilus (file browser) specific preferences
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NautilusSettings {
    /// Default view for the file browser: "grid" or "list"
    pub default_layout: String,
    /// Preferred grid icon size in pixels (e.g. 60)
    pub grid_icon_size: Option<i32>,
    /// Preferred list icon size in pixels (e.g. 40)
    pub list_icon_size: Option<i32>,
    /// Show hidden files by default in the file browser
    pub show_hidden_items: bool,
    /// Default sort key (e.g. "name-asc")
    pub sort_key: String,
    /// Starred items saved as an array of objects with remote and entry information.
    pub starred: Option<Vec<Value>>,
    /// Bookmarks saved as an array of objects with remote and entry information.
    pub bookmarks: Option<Vec<Value>>,
}

/// The complete settings model
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub core: CoreSettings,
    pub developer: DeveloperSettings,
    pub runtime: RuntimeSettings,
    pub nautilus: NautilusSettings,
}

/// Platform-specific default terminal apps
pub fn default_terminal_apps() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        vec![
            "gnome-terminal -- bash -c \"{}\"".to_string(),
            "kgx -- bash -c \"{}\"".to_string(),
            "konsole -e bash -c \"{}\"".to_string(),
            "xfce4-terminal -e 'bash -c \"{}\"'".to_string(),
            "alacritty -e bash -c \"{}\"".to_string(),
            "kitty bash -c \"{}\"".to_string(),
            "terminator -e 'bash -c \"{}\"'".to_string(),
            "tilix -e 'bash -c \"{}\"'".to_string(),
            "x-terminal-emulator -e bash -c \"{}\"".to_string(),
            "xterm -e bash -c \"{}\"".to_string(),
            "urxvt -e bash -c \"{}\"".to_string(),
        ]
    }
    #[cfg(target_os = "macos")]
    {
        vec![
            "osascript -e \"tell application \\\"Terminal\\\" to do script \\\"{}\\\"\""
                .to_string(),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        vec![
            "wt new-tab --title 'Rclone Config' -- cmd /K {}".to_string(),
            "wt new-tab --title 'Rclone Config' -- \"\" powershell -NoExit -Command \"& {}\""
                .to_string(),
            "cmd /C start cmd /K {}".to_string(),
            "cmd /C start \"\" powershell -NoExit -Command \"& {}\"".to_string(),
            "cmd /C start \"\" pwsh -NoExit -Command \"& {}\"".to_string(),
        ]
    }
}

/// Single Source of Truth for default values
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            general: GeneralSettings {
                tray_enabled: true,
                start_on_startup: false,
                notifications: true,
                restrict: true,
            },
            core: CoreSettings {
                max_tray_items: 5,
                rclone_api_port: 51900,
                rclone_oauth_port: 51901,
                connection_check_urls: vec![
                    "https://www.google.com".to_string(),
                    "https://www.dropbox.com".to_string(),
                    "https://onedrive.live.com".to_string(),
                ],
                bandwidth_limit: "".to_string(),
                rclone_config_file: "".to_string(),
                rclone_path: "".to_string(),
                completed_onboarding: false,
                terminal_apps: default_terminal_apps(),
            },
            developer: DeveloperSettings {
                debug_logging: false,
                destroy_window_on_close: false,
            },
            runtime: RuntimeSettings {
                theme: "system".to_string(),
                app_auto_check_updates: true,
                app_skipped_updates: vec![],
                app_update_channel: "stable".to_string(),
                rclone_auto_check_updates: true,
                rclone_skipped_updates: vec![],
                rclone_update_channel: "stable".to_string(),
                flatpak_warn: true,
                dashboard_layout: None,
            },
            nautilus: NautilusSettings {
                default_layout: "grid".to_string(),
                grid_icon_size: Some(72),
                list_icon_size: Some(40),
                show_hidden_items: false,
                sort_key: "name-asc".to_string(),
                starred: Some(vec![]),
                bookmarks: Some(vec![]),
            },
        }
    }
}

// =============================================================================
// SettingsSchema Implementation for AppSettings
// =============================================================================

impl SettingsSchema for AppSettings {
    fn get_metadata() -> HashMap<String, RcmanSettingMetadata> {
        let defaults = AppSettings::default();

        settings! {
            // =====================================================================
            // General Settings
            // =====================================================================
            "general.tray_enabled" => RcmanSettingMetadata::toggle("Enable Tray Icon", defaults.general.tray_enabled)
                .category("general")
                .description("Show an icon in the system tray. Also enables the background service."),

            "general.start_on_startup" => RcmanSettingMetadata::toggle("Start on Startup", defaults.general.start_on_startup)
                .category("general")
                .description("Automatically start the app when the system starts."),

            "general.notifications" => RcmanSettingMetadata::toggle("Enable Notifications", defaults.general.notifications)
                .category("general")
                .description("Show notifications for mount events."),

            "general.restrict" => RcmanSettingMetadata::toggle("Restrict Values", defaults.general.restrict)
                .category("general")
                .description("Restrict some specific values for security purposes (e.g., Token, Client ID, etc.)"),

            // =====================================================================
            // Core Settings
            // =====================================================================
            "core.max_tray_items" => RcmanSettingMetadata::number("Max Tray Items", defaults.core.max_tray_items as f64)
                .category("core")
                .description("Maximum number of items to show in the tray (1-40).")
                .min(1.0).max(40.0).step(1.0)
                .placeholder("e.g., 5"),

            "core.rclone_api_port" => RcmanSettingMetadata::number("Rclone API Port", defaults.core.rclone_api_port as f64)
                .category("core")
                .description("Port used for Rclone API communication (1024-65535).")
                .min(1024.0).max(65535.0).step(1.0)
                .requires_restart(),

            "core.rclone_oauth_port" => RcmanSettingMetadata::number("Rclone OAuth Port", defaults.core.rclone_oauth_port as f64)
                .category("core")
                .description("Port used for Rclone OAuth communication (1024-65535).")
                .min(1024.0).max(65535.0).step(1.0),

            "core.bandwidth_limit" => RcmanSettingMetadata::text("Bandwidth Limit", defaults.core.bandwidth_limit.clone())
                .category("core")
                .description("Limit the bandwidth used by Rclone transfers. Format: 'upload:download'")
                .placeholder("e.g., 10M or 5M:2M"),

            "core.rclone_config_file" => RcmanSettingMetadata::path("Rclone Config File", defaults.core.rclone_config_file.clone())
                .category("core")
                .description("Path to rclone config file. Leave empty to use default location.")
                .requires_restart(),

            "core.rclone_path" => RcmanSettingMetadata::path("Rclone Binary Path", defaults.core.rclone_path.clone())
                .category("core")
                .description("Path to rclone binary or directory. Leave empty for auto-detection, use 'system' for system PATH.")
                .requires_restart(),

            "core.completed_onboarding" => RcmanSettingMetadata::toggle("Completed Onboarding", defaults.core.completed_onboarding)
                .category("core")
                .description("Indicates if the onboarding process is completed."),

            // =====================================================================
            // Developer Settings
            // =====================================================================
            "developer.debug_logging" => RcmanSettingMetadata::toggle("Enable Debug Logging", defaults.developer.debug_logging)
                .category("developer")
                .description("Enable detailed logging for debugging.")
                .advanced(),

            "developer.destroy_window_on_close" => RcmanSettingMetadata::toggle("Memory Optimization", defaults.developer.destroy_window_on_close)
                .category("developer")
                .description("Destroys the window UI when closed to free RAM. Experimental feature.")
                .advanced(),

            // =====================================================================
            // Runtime Settings
            // =====================================================================
            "runtime.theme" => RcmanSettingMetadata::select("Application Theme", defaults.runtime.theme.clone(), vec![
                opt("system", "System"),
                opt("light", "Light"),
                opt("dark", "Dark"),
            ]).category("runtime"),

            "runtime.app_auto_check_updates" => RcmanSettingMetadata::toggle("Auto Check App Updates", defaults.runtime.app_auto_check_updates)
                .category("runtime")
                .description("Automatically check for application updates."),

            "runtime.app_update_channel" => RcmanSettingMetadata::select("App Update Channel", defaults.runtime.app_update_channel.clone(), vec![
                opt("stable", "Stable"),
                opt("beta", "Beta"),
            ]).category("runtime"),

            "runtime.rclone_auto_check_updates" => RcmanSettingMetadata::toggle("Auto Check Rclone Updates", defaults.runtime.rclone_auto_check_updates)
                .category("runtime")
                .description("Automatically check for rclone updates."),

            "runtime.rclone_update_channel" => RcmanSettingMetadata::select("Rclone Update Channel", defaults.runtime.rclone_update_channel.clone(), vec![
                opt("stable", "Stable"),
                opt("beta", "Beta"),
            ]).category("runtime"),

            "runtime.flatpak_warn" => RcmanSettingMetadata::toggle("Flatpak Warning Shown", defaults.runtime.flatpak_warn)
                .category("runtime"),

            // =====================================================================
            // Nautilus (File Browser) Settings
            // =====================================================================
            "nautilus.default_layout" => RcmanSettingMetadata::select("Default Layout", defaults.nautilus.default_layout.clone(), vec![
                opt("grid", "Grid"),
                opt("list", "List"),
            ]).category("nautilus")
            .description("Default view layout for the file browser."),

            "nautilus.grid_icon_size" => RcmanSettingMetadata::number("Grid Icon Size", 72.0)
                .category("nautilus")
                .description("Preferred grid icon size in pixels.")
                .min(16.0).max(512.0).step(1.0),

            "nautilus.list_icon_size" => RcmanSettingMetadata::number("List Icon Size", 40.0)
                .category("nautilus")
                .description("Preferred list icon size in pixels.")
                .min(16.0).max(256.0).step(1.0),

            "nautilus.show_hidden_items" => RcmanSettingMetadata::toggle("Show Hidden Files", defaults.nautilus.show_hidden_items)
                .category("nautilus")
                .description("Show files starting with a dot by default in the file browser."),

            "nautilus.sort_key" => RcmanSettingMetadata::select("Default Sort Order", defaults.nautilus.sort_key.clone(), vec![
                opt("name-asc", "Name (A-Z)"),
                opt("name-desc", "Name (Z-A)"),
                opt("size-asc", "Size (Small-Large)"),
                opt("size-desc", "Size (Large-Small)"),
                opt("date-asc", "Date (Old-New)"),
                opt("date-desc", "Date (New-Old)"),
            ]).category("nautilus"),
        }
    }
}
