//! rcman-compatible settings schema for RClone Manager
//!
//! This module provides the SettingsSchema implementation for the existing
//! AppSettings types, using the derive macro for simplified definition.

use rcman::DeriveSettingsSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// =============================================================================
// Struct Definitions with Derive Macro
// =============================================================================

/// General settings
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "general")]
pub struct GeneralSettings {
    #[setting(
        label = "Enable Tray Icon",
        description = "Show an icon in the system tray. Also enables the background service."
    )]
    pub tray_enabled: bool,

    #[setting(
        label = "Start on Startup",
        description = "Automatically start the app when the system starts."
    )]
    pub start_on_startup: bool,

    #[setting(
        label = "Enable Notifications",
        description = "Show notifications for mount events."
    )]
    pub notifications: bool,

    #[setting(
        label = "Restrict Values",
        description = "Restrict some specific values for security purposes (e.g., Token, Client ID, etc.)"
    )]
    pub restrict: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            tray_enabled: true,
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
        label = "Max Tray Items",
        description = "Maximum number of items to show in the tray (1-40).",
        min = 1,
        max = 40,
        step = 1
    )]
    pub max_tray_items: usize,

    #[setting(skip)] // Complex type, skip from schema
    pub connection_check_urls: Vec<String>,

    #[setting(
        label = "Rclone Config File",
        description = "Path to rclone config file. Leave empty to use default location.",
        requires_restart
    )]
    pub rclone_config_file: String,

    #[setting(
        label = "Rclone Binary Path",
        description = "Path to rclone binary or directory. Leave empty for auto-detection.",
        requires_restart
    )]
    pub rclone_path: String,

    #[setting(
        label = "Bandwidth Limit",
        description = "Limit the bandwidth used by Rclone transfers. Format: 'upload:download'"
    )]
    pub bandwidth_limit: String,

    #[setting(
        label = "Completed Onboarding",
        description = "Indicates if the onboarding process is completed."
    )]
    pub completed_onboarding: bool,

    #[setting(skip)] // Complex type, skip from schema
    pub terminal_apps: Vec<String>,
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
    // Mobile platforms (Android/iOS) - no terminal apps
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        vec![]
    }
}

impl Default for CoreSettings {
    fn default() -> Self {
        Self {
            max_tray_items: 5,
            connection_check_urls: vec![
                "https://www.google.com".to_string(),
                "https://www.dropbox.com".to_string(),
                "https://onedrive.live.com".to_string(),
            ],
            bandwidth_limit: String::new(),
            rclone_config_file: String::new(),
            rclone_path: String::new(),
            completed_onboarding: false,
            terminal_apps: default_terminal_apps(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "developer")]
pub struct DeveloperSettings {
    #[setting(
        label = "Log Level",
        description = "Controls which log messages are recorded. Higher levels include more detail.",
        options(
            ("error", "Error Only"),
            ("warn", "Warnings & Errors"),
            ("info", "Info (Recommended)"),
            ("debug", "Debug (Verbose)"),
            ("trace", "Trace (All, includes library logs)")
        ),
        advanced
    )]
    pub log_level: String,

    #[setting(
        label = "Memory Optimization",
        description = "Destroys the window UI when closed to free RAM. Experimental feature.",
        advanced
    )]
    pub destroy_window_on_close: bool,
}

impl Default for DeveloperSettings {
    fn default() -> Self {
        Self {
            log_level: "info".to_string(),
            destroy_window_on_close: false,
        }
    }
}

/// Runtime settings
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "runtime")]
pub struct RuntimeSettings {
    #[setting(label = "Application Theme", options(("system", "System"), ("light", "Light"), ("dark", "Dark")))]
    pub theme: String,

    #[setting(
        label = "Auto Check App Updates",
        description = "Automatically check for application updates."
    )]
    pub app_auto_check_updates: bool,

    #[setting(
        label = "Skipped App Updates",
        description = "List of application versions that have been skipped."
    )]
    pub app_skipped_updates: Vec<String>,

    #[setting(label = "App Update Channel", options(("stable", "Stable"), ("beta", "Beta")))]
    pub app_update_channel: String,

    #[setting(
        label = "Auto Check Rclone Updates",
        description = "Automatically check for rclone updates."
    )]
    pub rclone_auto_check_updates: bool,

    #[setting(
        label = "Skipped Rclone Updates",
        description = "List of rclone versions that have been skipped."
    )]
    pub rclone_skipped_updates: Vec<String>,

    #[setting(label = "Rclone Update Channel", options(("stable", "Stable"), ("beta", "Beta")))]
    pub rclone_update_channel: String,

    #[setting(label = "Flatpak Warning Shown")]
    pub flatpak_warn: bool,

    #[setting(skip)] // Complex type
    pub dashboard_layout: Option<Vec<String>>,
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
            dashboard_layout: None,
        }
    }
}

/// Nautilus (file browser) specific preferences
#[derive(Debug, Serialize, Deserialize, Clone, DeriveSettingsSchema)]
#[schema(category = "nautilus")]
pub struct NautilusSettings {
    #[setting(label = "Default Layout", description = "Default view layout for the file browser.", options(("grid", "Grid"), ("list", "List")))]
    pub default_layout: String,

    #[setting(
        label = "Grid Icon Size",
        description = "Preferred grid icon size in pixels.",
        min = 16,
        max = 512
    )]
    pub grid_icon_size: i32,

    #[setting(
        label = "List Icon Size",
        description = "Preferred list icon size in pixels.",
        min = 16,
        max = 256
    )]
    pub list_icon_size: i32,

    #[setting(
        label = "Show Hidden Files",
        description = "Show files starting with a dot by default in the file browser."
    )]
    pub show_hidden_items: bool,

    #[setting(label = "Default Sort Order", options(
        ("name-asc", "Name (A-Z)"),
        ("name-desc", "Name (Z-A)"),
        ("size-asc", "Size (Small-Large)"),
        ("size-desc", "Size (Large-Small)"),
        ("date-asc", "Date (Old-New)"),
        ("date-desc", "Date (New-Old)")
    ))]
    pub sort_key: String,

    #[setting(skip)] // Complex type
    pub starred: Option<Vec<Value>>,

    #[setting(skip)] // Complex type
    pub bookmarks: Option<Vec<Value>>,
}

impl Default for NautilusSettings {
    fn default() -> Self {
        Self {
            default_layout: "grid".to_string(),
            grid_icon_size: 72,
            list_icon_size: 40,
            show_hidden_items: false,
            sort_key: "name-asc".to_string(),
            starred: Some(vec![]),
            bookmarks: Some(vec![]),
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
