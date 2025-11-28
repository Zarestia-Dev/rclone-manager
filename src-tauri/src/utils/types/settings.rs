use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::Runtime;
use tauri_plugin_store::Store;
use tokio::sync::Mutex;

use crate::utils::types::all_types::DashboardPanel;

/// 🛠️ Metadata for settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SettingMetadata {
    pub display_name: String,
    pub value_type: String,
    pub help_text: String,
    pub default: Value,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_value: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_restart: Option<bool>,
}

// Implement Default for cleaner instantiation
impl Default for SettingMetadata {
    fn default() -> Self {
        Self {
            display_name: String::new(),
            value_type: "string".to_string(),
            help_text: String::new(),
            default: Value::Null,
            value: None,
            min_value: None,
            max_value: None,
            step: None,
            placeholder: None,
            options: None,
            required: None,
            engine_restart: None,
        }
    }
}

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
    pub dashboard_layout: Option<Vec<DashboardPanel>>,
}

/// Nautilus (file browser) specific preferences
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NautilusSettings {
    /// Default view for the file browser: "grid" or "list"
    pub default_layout: String,
    /// Preferred grid icon size in pixels (e.g. 60)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_icon_size: Option<i32>,
    /// Preferred list icon size in pixels (e.g. 40)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_icon_size: Option<i32>,
    /// Show hidden files by default in the file browser
    pub show_hidden_by_default: bool,
    /// Default sort key (e.g. "name-asc")
    pub sort_key: String,
    /// Starred items saved as an array of objects with remote and entry information.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starred: Option<Vec<Value>>,
}

/// The complete settings model
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub core: CoreSettings,
    pub developer: DeveloperSettings,
    pub runtime: RuntimeSettings,
    pub nautilus: NautilusSettings, // Moved to top level
}

/// **Global settings state**
pub struct SettingsState<R: Runtime> {
    pub store: Mutex<Arc<Store<R>>>,
    pub config_dir: PathBuf,
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
                grid_icon_size: Some(60),
                list_icon_size: Some(40),
                show_hidden_by_default: false,
                sort_key: "name-asc".to_string(),
                starred: Some(vec![]),
            },
        }
    }
}

// Static cache for metadata to avoid re-computing it on every call
static SETTINGS_METADATA: Lazy<HashMap<String, SettingMetadata>> = Lazy::new(|| {
    let mut metadata = HashMap::new();
    let defaults = AppSettings::default();

    // Helper closure to simplify insertion
    let mut add = |key: &str, meta: SettingMetadata| {
        metadata.insert(key.to_string(), meta);
    };

    // --- General Settings ---
    add(
        "general.start_on_startup",
        SettingMetadata {
            display_name: "Start on Startup".into(),
            value_type: "bool".into(),
            help_text: "Automatically start the app when the system starts.".into(),
            default: json!(defaults.general.start_on_startup),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "general.notifications",
        SettingMetadata {
            display_name: "Enable Notifications".into(),
            value_type: "bool".into(),
            help_text: "Show notifications for mount events.".into(),
            default: json!(defaults.general.notifications),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "general.tray_enabled",
        SettingMetadata {
            display_name: "Enable Tray Icon".into(),
            value_type: "bool".into(),
            help_text: "Show an icon in the system tray. Also enables the background service."
                .into(),
            default: json!(defaults.general.tray_enabled),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "general.restrict",
        SettingMetadata {
            display_name: "Restrict Values".into(),
            value_type: "bool".into(),
            help_text:
                "Restrict some specific values for security purposes (e.g., Token, Client ID, etc.)"
                    .into(),
            default: json!(defaults.general.restrict),
            required: Some(true),
            ..Default::default()
        },
    );

    // --- Core Settings ---
    add("core.bandwidth_limit", SettingMetadata {
        display_name: "Bandwidth Limit".into(),
        value_type: "bandwidth".into(),
        help_text: "Limit the bandwidth used by Rclone transfers. It can be specified as 'upload:download'".into(),
        default: json!(defaults.core.bandwidth_limit),
        placeholder: Some("e.g., 10M or 5M:2M".into()),
        ..Default::default()
    });

    add(
        "core.rclone_api_port",
        SettingMetadata {
            display_name: "Rclone API Port".into(),
            value_type: "int".into(),
            help_text: "Port used for Rclone API communication (1024-65535).".into(),
            default: json!(defaults.core.rclone_api_port),
            min_value: Some(1024),
            max_value: Some(65535),
            step: Some(1),
            placeholder: Some("e.g., 51900".into()),
            required: Some(true),
            engine_restart: Some(true),
            ..Default::default()
        },
    );

    add(
        "core.rclone_oauth_port",
        SettingMetadata {
            display_name: "Rclone OAuth Port".into(),
            value_type: "int".into(),
            help_text: "Port used for Rclone OAuth communication (1024-65535).".into(),
            default: json!(defaults.core.rclone_oauth_port),
            min_value: Some(1024),
            max_value: Some(65535),
            step: Some(1),
            placeholder: Some("e.g., 51901".into()),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "core.connection_check_urls",
        SettingMetadata {
            display_name: "Connection Check URLs".into(),
            value_type: "string[]".into(),
            help_text: "List of URLs to check for internet connectivity".into(),
            default: json!(defaults.core.connection_check_urls),
            placeholder: Some("https://google.com".into()),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "core.max_tray_items",
        SettingMetadata {
            display_name: "Max Tray Items".into(),
            value_type: "int".into(),
            help_text: "Maximum number of items to show in the tray (1-40).".into(),
            default: json!(defaults.core.max_tray_items),
            min_value: Some(1),
            max_value: Some(40),
            step: Some(1),
            placeholder: Some("e.g., 5".into()),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "core.completed_onboarding",
        SettingMetadata {
            display_name: "Completed Onboarding".into(),
            value_type: "bool".into(),
            help_text: "Indicates if the onboarding process is completed.".into(),
            default: json!(defaults.core.completed_onboarding),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "core.rclone_config_file",
        SettingMetadata {
            display_name: "Rclone Config File".into(),
            value_type: "file".into(),
            help_text: "Path to rclone config file. Leave empty to use default location.".into(),
            default: json!(defaults.core.rclone_config_file),
            placeholder: Some("e.g., /home/user/.config/rclone/rclone.conf".into()),
            engine_restart: Some(true),
            ..Default::default()
        },
    );

    add("core.rclone_path", SettingMetadata {
        display_name: "Rclone Binary Path".into(),
        value_type: "folder".into(),
        help_text: "Path to rclone binary or directory. Leave empty for auto-detection, use 'system' for system PATH.".into(),
        default: json!(defaults.core.rclone_path),
        placeholder: Some("e.g., /path/to/rclone or 'system'".into()),
        engine_restart: Some(true),
        ..Default::default()
    });

    add(
        "core.terminal_apps",
        SettingMetadata {
            display_name: "Preferred Terminal Apps".into(),
            value_type: "string[]".into(),
            help_text: "List of terminal applications to use for commands.".into(),
            default: json!(defaults.core.terminal_apps),
            placeholder: Some("e.g., gnome-terminal, x-terminal-emulator".into()),
            required: Some(true),
            ..Default::default()
        },
    );

    // --- Developer Settings ---
    add(
        "developer.debug_logging",
        SettingMetadata {
            display_name: "Enable Debug Logging".into(),
            value_type: "bool".into(),
            help_text: "Enable detailed logging for debugging.".into(),
            default: json!(defaults.developer.debug_logging),
            required: Some(true),
            ..Default::default()
        },
    );

    // --- Runtime Settings ---
    add(
        "runtime.theme",
        SettingMetadata {
            display_name: "Application Theme".into(),
            value_type: "string".into(),
            help_text: "The current UI theme (system, light, or dark).".into(),
            default: json!(defaults.runtime.theme),
            ..Default::default()
        },
    );

    add(
        "runtime.app_auto_check_updates",
        SettingMetadata {
            display_name: "App Auto Check Updates".into(),
            value_type: "bool".into(),
            help_text: "Automatically check for application updates.".into(),
            default: json!(defaults.runtime.app_auto_check_updates),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "runtime.app_skipped_updates",
        SettingMetadata {
            display_name: "App Skipped Updates".into(),
            value_type: "string[]".into(),
            help_text: "List of application versions to skip during update checks.".into(),
            default: json!(defaults.runtime.app_skipped_updates),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "runtime.app_update_channel",
        SettingMetadata {
            display_name: "App Update Channel".into(),
            value_type: "string".into(),
            help_text: "The update channel for the application (stable, beta, etc.).".into(),
            default: json!(defaults.runtime.app_update_channel),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "runtime.rclone_auto_check_updates",
        SettingMetadata {
            display_name: "Rclone Auto Check Updates".into(),
            value_type: "bool".into(),
            help_text: "Automatically check for rclone updates.".into(),
            default: json!(defaults.runtime.rclone_auto_check_updates),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "runtime.rclone_skipped_updates",
        SettingMetadata {
            display_name: "Rclone Skipped Updates".into(),
            value_type: "string[]".into(),
            help_text: "List of rclone versions to skip during update checks.".into(),
            default: json!(defaults.runtime.rclone_skipped_updates),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "runtime.rclone_update_channel",
        SettingMetadata {
            display_name: "Rclone Update Channel".into(),
            value_type: "string".into(),
            help_text: "The update channel for rclone (stable, beta, etc.).".into(),
            default: json!(defaults.runtime.rclone_update_channel),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "runtime.flatpak_warn",
        SettingMetadata {
            display_name: "Flatpak Warning Shown".into(),
            value_type: "bool".into(),
            help_text: "".into(),
            default: json!(defaults.runtime.flatpak_warn),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "runtime.dashboard_layout",
        SettingMetadata {
            display_name: "Dashboard Layout Style".into(),
            value_type: "string[]".into(),
            help_text: "".into(),
            default: json!(defaults.runtime.dashboard_layout),
            required: Some(true),
            ..Default::default()
        },
    );

    // --- Nautilus (file browser) settings ---
    // Note: These are now top-level keys to match the simplified struct structure

    add(
        "nautilus.default_layout",
        SettingMetadata {
            display_name: "Default File Browser Layout".into(),
            value_type: "string".into(),
            help_text: "Default view layout for the file browser (grid or list).".into(),
            default: json!(defaults.nautilus.default_layout),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "nautilus.grid_icon_size",
        SettingMetadata {
            display_name: "Grid Icon Size".into(),
            value_type: "int".into(),
            help_text: "Preferred grid icon size in pixels.".into(),
            default: json!(defaults.nautilus.grid_icon_size),
            min_value: Some(16),
            max_value: Some(512),
            step: Some(1),
            placeholder: Some("e.g., 60".into()),
            ..Default::default()
        },
    );

    add(
        "nautilus.list_icon_size",
        SettingMetadata {
            display_name: "List Icon Size".into(),
            value_type: "int".into(),
            help_text: "Preferred list icon size in pixels.".into(),
            default: json!(defaults.nautilus.list_icon_size),
            min_value: Some(16),
            max_value: Some(256),
            step: Some(1),
            placeholder: Some("e.g., 40".into()),
            ..Default::default()
        },
    );

    add(
        "nautilus.show_hidden_by_default",
        SettingMetadata {
            display_name: "Show Hidden Files By Default".into(),
            value_type: "bool".into(),
            help_text: "Show files starting with a dot by default in the file browser.".into(),
            default: json!(defaults.nautilus.show_hidden_by_default),
            required: Some(true),
            ..Default::default()
        },
    );

    add(
        "nautilus.sort_key",
        SettingMetadata {
            display_name: "Default Sort Order".into(),
            value_type: "string".into(),
            help_text: "Default sort order for the file browser (e.g. name-asc).".into(),
            default: json!(defaults.nautilus.sort_key),
            ..Default::default()
        },
    );

    add(
        "nautilus.starred",
        SettingMetadata {
            display_name: "Starred Items".into(),
            value_type: "object[]".into(),
            help_text: "List of starred items with remote and entry details.".into(),
            default: json!(defaults.nautilus.starred),
            placeholder: Some("e.g., { remote: 'gdrive', entry: { ... } }".into()),
            ..Default::default()
        },
    );

    metadata
});

/// Single Source of Truth for UI Metadata (which reads from `default()`)
impl AppSettings {
    pub fn get_metadata() -> HashMap<String, SettingMetadata> {
        // Return clone of the lazy static map
        SETTINGS_METADATA.clone()
    }
}
