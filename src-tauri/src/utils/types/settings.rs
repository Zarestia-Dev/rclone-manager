use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::Runtime;
use tauri_plugin_store::Store;
use tokio::sync::Mutex;

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
}

/// The complete settings model
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub core: CoreSettings,
    pub developer: DeveloperSettings,
    pub runtime: RuntimeSettings,
}

/// **Global settings state**
pub struct SettingsState<R: Runtime> {
    pub store: Mutex<Arc<Store<R>>>,
    pub config_dir: PathBuf,
}

/// Macro to build SettingMetadata, reading the default from the `defaults` struct
macro_rules! setting_meta {
    (
        $display_name:expr,
        $value_type:expr,
        $help_text:expr,
        default = $default:expr
        $(, min = $min_value:expr)?
        $(, max = $max_value:expr)?
        $(, step = $step:expr)?
        $(, placeholder = $placeholder:expr)?
        $(, required = $required:expr)?
        $(, engine_restart = $engine_restart:expr)?
    ) => {
        SettingMetadata {
            display_name: $display_name.to_string(),
            value_type: $value_type.to_string(),
            help_text: $help_text.to_string(),
            default: json!($default),
            value: None,
            min_value: None $(.or(Some($min_value)))?,
            max_value: None $(.or(Some($max_value)))?,
            step: None $(.or(Some($step)))?,
            placeholder: None $(.or(Some($placeholder.to_string())))?,
            options: None,
            required: None $(.or(Some($required)))?,
            engine_restart: None $(.or(Some($engine_restart)))?,
        }
    };
}

/// Platform-specific default terminal apps
pub fn default_terminal_apps() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        vec![
            // GNOME-based terminals
            "gnome-terminal -- bash -c \"{}\"".to_string(),
            "kgx -- bash -c \"{}\"".to_string(),
            // KDE
            "konsole -e bash -c \"{}\"".to_string(),
            // XFCE
            "xfce4-terminal -e 'bash -c \"{}\"'".to_string(),
            // Modern terminals
            "alacritty -e bash -c \"{}\"".to_string(),
            "kitty bash -c \"{}\"".to_string(),
            "terminator -e 'bash -c \"{}\"'".to_string(),
            "tilix -e 'bash -c \"{}\"'".to_string(),
            // Fallbacks
            "x-terminal-emulator -e bash -c \"{}\"".to_string(),
            "xterm -e bash -c \"{}\"".to_string(),
            "urxvt -e bash -c \"{}\"".to_string(),
        ]
    }
    #[cfg(target_os = "macos")]
    {
        vec![
            // Terminal.app (built-in)
            "osascript -e \"tell application \\\"Terminal\\\" to do script \\\"{}\\\"\""
                .to_string(),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        vec![
            // Windows Terminal (modern, cmd)
            "wt new-tab --title 'Rclone Config' -- cmd /K {}".to_string(),
            // Windows Terminal (modern, PowerShell)
            "wt new-tab --title 'Rclone Config' -- \"\" powershell -NoExit -Command \"& {}\""
                .to_string(),
            // Command Prompt (always available)
            "cmd /C start cmd /K {}".to_string(),
            // PowerShell
            "cmd /C start \"\" powershell -NoExit -Command \"& {}\"".to_string(),
            // PowerShell Core (if available)
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
                // default_mount_type: "native".to_string(),
                bandwidth_limit: "".to_string(),
                rclone_config_file: "".to_string(),
                rclone_path: "".to_string(), // Empty means auto-detect
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
            },
        }
    }
}

/// Single Source of Truth for UI Metadata (which reads from `default()`)
impl AppSettings {
    pub fn get_metadata() -> HashMap<String, SettingMetadata> {
        let mut metadata = HashMap::new();
        let defaults = AppSettings::default();

        // General Settings
        metadata.insert(
            "general.start_on_startup".to_string(),
            setting_meta!(
                "Start on Startup",
                "bool",
                "Automatically start the app when the system starts.",
                default = defaults.general.start_on_startup,
                required = true
            ),
        );

        metadata.insert(
            "general.notifications".to_string(),
            setting_meta!(
                "Enable Notifications",
                "bool",
                "Show notifications for mount events.",
                default = defaults.general.notifications,
                required = true
            ),
        );

        metadata.insert(
            "general.tray_enabled".to_string(),
            setting_meta!(
                "Enable Tray Icon",
                "bool",
                "Show an icon in the system tray. Also enables the background service.",
                default = defaults.general.tray_enabled,
                required = true
            ),
        );

        metadata.insert(
            "general.restrict".to_string(),
            setting_meta!(
                "Restrict Values",
                "bool",
                "Restrict some specific values for security purposes (e.g., Token, Client ID, etc.)",
                default = defaults.general.restrict,
                required = true
            ),
        );

        // Core Settings
        metadata.insert(
            "core.bandwidth_limit".to_string(),
            setting_meta!(
                "Bandwidth Limit",
                "bandwidth",
                "Limit the bandwidth used by Rclone transfers. It can be specified as 'upload:download'",
                default = defaults.core.bandwidth_limit,
                placeholder = "e.g., 10M or 5M:2M"
            ),
        );

        metadata.insert(
            "core.rclone_api_port".to_string(),
            setting_meta!(
                "Rclone API Port",
                "int",
                "Port used for Rclone API communication (1024-65535).",
                default = defaults.core.rclone_api_port,
                min = 1024,
                max = 65535,
                step = 1,
                placeholder = "e.g., 51900",
                required = true,
                engine_restart = true
            ),
        );

        metadata.insert(
            "core.rclone_oauth_port".to_string(),
            setting_meta!(
                "Rclone OAuth Port",
                "int",
                "Port used for Rclone OAuth communication (1024-65535).",
                default = defaults.core.rclone_oauth_port,
                min = 1024,
                max = 65535,
                step = 1,
                placeholder = "e.g., 51901",
                required = true
            ),
        );

        metadata.insert(
            "core.connection_check_urls".to_string(),
            setting_meta!(
                "Connection Check URLs",
                "string[]",
                "List of URLs to check for internet connectivity",
                default = json!(defaults.core.connection_check_urls),
                placeholder = "https://google.com",
                required = true
            ),
        );

        metadata.insert(
            "core.max_tray_items".to_string(),
            setting_meta!(
                "Max Tray Items",
                "int",
                "Maximum number of items to show in the tray (1-40).",
                default = defaults.core.max_tray_items,
                min = 1,
                max = 40,
                step = 1,
                placeholder = "e.g., 5",
                required = true
            ),
        );

        metadata.insert(
            "core.completed_onboarding".to_string(),
            setting_meta!(
                "Completed Onboarding",
                "bool",
                "Indicates if the onboarding process is completed.",
                default = defaults.core.completed_onboarding,
                required = true
            ),
        );

        metadata.insert(
            "core.rclone_config_file".to_string(),
            setting_meta!(
                "Rclone Config File",
                "file",
                "Path to rclone config file. Leave empty to use default location.",
                default = defaults.core.rclone_config_file,
                placeholder = "e.g., /home/user/.config/rclone/rclone.conf",
                engine_restart = true
            ),
        );

        metadata.insert(
            "core.rclone_path".to_string(),
            setting_meta!(
                "Rclone Binary Path",
                "folder",
                "Path to rclone binary or directory. Leave empty for auto-detection, use 'system' for system PATH.",
                default = defaults.core.rclone_path,
                placeholder = "e.g., /path/to/rclone or 'system'",
                engine_restart = true
            ),
        );

        metadata.insert(
            "core.terminal_apps".to_string(),
            setting_meta!(
                "Preferred Terminal Apps",
                "string[]",
                "List of terminal applications to use for commands.",
                default = json!(defaults.core.terminal_apps),
                placeholder = "e.g., gnome-terminal, x-terminal-emulator",
                required = true
            ),
        );

        // Developer Settings
        metadata.insert(
            "developer.debug_logging".to_string(),
            setting_meta!(
                "Enable Debug Logging",
                "bool",
                "Enable detailed logging for debugging.",
                default = defaults.developer.debug_logging,
                required = true
            ),
        );

        // Runtime Settings
        metadata.insert(
            "runtime.theme".to_string(),
            setting_meta!(
                "Application Theme",
                "string",
                "The current UI theme (system, light, or dark).",
                default = defaults.runtime.theme
            ),
        );

        metadata.insert(
            "runtime.app_auto_check_updates".to_string(),
            setting_meta!(
                "App Auto Check Updates",
                "bool",
                "Automatically check for application updates.",
                default = true,
                required = true
            ),
        );
        metadata.insert(
            "runtime.app_skipped_updates".to_string(),
            setting_meta!(
                "App Skipped Updates",
                "string[]",
                "List of application versions to skip during update checks.",
                default = json!([]),
                required = true
            ),
        );
        metadata.insert(
            "runtime.app_update_channel".to_string(),
            setting_meta!(
                "App Update Channel",
                "string",
                "The update channel for the application (stable, beta, etc.).",
                default = "stable",
                required = true
            ),
        );

        metadata.insert(
            "runtime.rclone_auto_check_updates".to_string(),
            setting_meta!(
                "Rclone Auto Check Updates",
                "bool",
                "Automatically check for rclone updates.",
                default = true,
                required = true
            ),
        );

        metadata.insert(
            "runtime.rclone_skipped_updates".to_string(),
            setting_meta!(
                "Rclone Skipped Updates",
                "string[]",
                "List of rclone versions to skip during update checks.",
                default = json!([]),
                required = true
            ),
        );

        metadata.insert(
            "runtime.rclone_update_channel".to_string(),
            setting_meta!(
                "Rclone Update Channel",
                "string",
                "The update channel for rclone (stable, beta, etc.).",
                default = "stable",
                required = true
            ),
        );

        metadata.insert(
            "runtime.flatpak_warn".to_string(),
            setting_meta!(
                "Flatpak Warning Shown",
                "bool",
                "",
                default = defaults.runtime.flatpak_warn,
                required = true
            ),
        );

        metadata
    }
}
