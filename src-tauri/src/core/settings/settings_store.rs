// use regex::Regex;
use std::collections::HashMap;

use crate::utils::types::all_types::{
    AppSettings, CoreSettings, ExperimentalSettings, GeneralSettings, SettingMetadata,
};

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

/// ✅ Default settings
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            general: GeneralSettings {
                tray_enabled: true,
                start_on_startup: false,
                notifications: true,
                restrict: true, // default to true for security
            },
            core: CoreSettings {
                max_tray_items: 5,
                rclone_api_port: 51900,   // change port to dynamic port
                rclone_oauth_port: 51901, // change port to dynamic port
                connection_check_urls: vec![
                    "https://www.google.com".to_string(),
                    "https://www.dropbox.com".to_string(),
                    "https://onedrive.live.com".to_string(),
                ],
                // default_mount_type: "native".to_string(),
                bandwidth_limit: "".to_string(),
                rclone_config_path: "".to_string(),
                rclone_path: "".to_string(), // Empty means auto-detect
                completed_onboarding: false,
                terminal_apps: default_terminal_apps(),
            },
            experimental: ExperimentalSettings {
                debug_logging: false,
            },
        }
    }
}

// impl SettingMetadata {
//     /// Validates a setting value based on its metadata
//     pub fn validate(&self, value: &str) -> bool {
//         match self.value_type.as_str() {
//             "bool" => value == "true" || value == "false",
//             "number" => value.parse::<u64>().is_ok(),
//             "string" => {
//                 if let Some(pattern) = &self.validation_pattern {
//                     Regex::new(pattern).unwrap().is_match(value)
//                 } else {
//                     true
//                 }
//             }
//             _ => true,
//         }
//     }
// }

impl AppSettings {
    pub fn get_metadata() -> HashMap<String, SettingMetadata> {
        let mut metadata = HashMap::new();

        metadata.insert(
            "general.start_on_startup".to_string(),
            SettingMetadata {
                display_name: "Start on Startup".to_string(),
                value_type: "bool".to_string(),
                help_text: "Automatically start the app when the system starts.".to_string(),
                validation_type: None,
                validation_pattern: None,
                validation_message: None,
                min_value: None,
                max_value: None,
                step: None,
                placeholder: None,
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "general.notifications".to_string(),
            SettingMetadata {
                display_name: "Enable Notifications".to_string(),
                value_type: "bool".to_string(),
                help_text: "Show notifications for mount events.".to_string(),
                validation_type: None,
                validation_pattern: None,
                validation_message: None,
                min_value: None,
                max_value: None,
                step: None,
                placeholder: None,
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "general.tray_enabled".to_string(),
            SettingMetadata {
                display_name: "Enable Tray Icon".to_string(),
                value_type: "bool".to_string(),
                help_text: "Show an icon in the system tray. Also enables the background service."
                    .to_string(),
                validation_type: None,
                validation_pattern: None,
                validation_message: None,
                min_value: None,
                max_value: None,
                step: None,
                placeholder: None,
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "general.restrict".to_string(),
            SettingMetadata {
                display_name: "Restrict Values".to_string(),
                value_type: "bool".to_string(),
                help_text: "Restrict some specific values for security purposes (e.g., Token, Client ID, etc.)".to_string(),
                validation_type: None,
                validation_pattern: None,
                validation_message: None,
                min_value: None,
                max_value: None,
                step: None,
                placeholder: None,
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "core.bandwidth_limit".to_string(),
            SettingMetadata {
                display_name: "Bandwidth Limit".to_string(),
                value_type: "string".to_string(),
                help_text: "Limit the bandwidth used by Rclone transfers. It can be specified as 'upload:download'".to_string(),
                validation_type: Some("frontend:bandwidthFormat".to_string()),
                validation_pattern: None,
                validation_message: Some("The bandwidth should be of the form 1M|2M|1G|1K|1.1K etc. Can also be specified as (upload:download). Keep it empty for no limit.".to_string()),
                min_value: None,
                max_value: None,
                step: None,
                placeholder: Some("e.g., 10M or 5M:2M".to_string()),
                options: None,
                required: Some(false),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "core.rclone_api_port".to_string(),
            SettingMetadata {
                display_name: "Rclone API Port".to_string(),
                value_type: "number".to_string(),
                help_text: "Port used for Rclone API communication (1024-65535).".to_string(),
                validation_type: Some("frontend:portRange".to_string()),
                validation_pattern: None,
                validation_message: Some(
                    "Must be a valid port number between 1024 and 65535".to_string(),
                ),
                min_value: Some(1024),
                max_value: Some(65535),
                step: Some(1),
                placeholder: Some("e.g., 51900".to_string()),
                options: None,
                required: Some(true),
                requires_restart: Some(true),
            },
        );

        metadata.insert(
            "core.rclone_oauth_port".to_string(),
            SettingMetadata {
                display_name: "Rclone OAuth Port".to_string(),
                value_type: "number".to_string(),
                help_text: "Port used for Rclone OAuth communication (1024-65535).".to_string(),
                validation_type: Some("frontend:portRange".to_string()),
                validation_pattern: None,
                validation_message: Some(
                    "Must be a valid port number between 1024 and 65535".to_string(),
                ),
                min_value: Some(1024),
                max_value: Some(65535),
                step: Some(1),
                placeholder: Some("e.g., 51901".to_string()),
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "core.connection_check_urls".to_string(),
            SettingMetadata {
                display_name: "Connection Check URLs".to_string(),
                value_type: "array".to_string(),
                help_text: "List of URLs to check for internet connectivity".to_string(),
                validation_type: Some("frontend:urlList".to_string()),
                validation_pattern: None,
                validation_message: Some("All items must be valid URLs".to_string()),
                min_value: None,
                max_value: None,
                step: None,
                placeholder: Some("https://google.com".to_string()),
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "core.max_tray_items".to_string(),
            SettingMetadata {
                display_name: "Max Tray Items".to_string(),
                value_type: "number".to_string(),
                help_text: "Maximum number of items to show in the tray (1-40).".to_string(),
                validation_type: Some("frontend:trayItemsRange".to_string()),
                validation_pattern: None,
                validation_message: Some("Must be between 1 and 40".to_string()),
                min_value: Some(1),
                max_value: Some(40),
                step: Some(1),
                placeholder: Some("e.g., 5".to_string()),
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "core.completed_onboarding".to_string(),
            SettingMetadata {
                display_name: "Completed Onboarding".to_string(),
                value_type: "bool".to_string(),
                help_text: "Indicates if the onboarding process is completed.".to_string(),
                validation_type: None,
                validation_pattern: None,
                validation_message: None,
                min_value: None,
                max_value: None,
                step: None,
                placeholder: None,
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "core.rclone_config_path".to_string(),
            SettingMetadata {
                display_name: "Rclone Config Path".to_string(),
                value_type: "path".to_string(),
                help_text: "Path to rclone config file. Leave empty to use default location."
                    .to_string(),
                validation_type: Some("frontend:crossPlatformPath".to_string()),
                validation_pattern: None,
                validation_message: Some("Must be a valid file path".to_string()),
                min_value: None,
                max_value: None,
                step: None,
                placeholder: Some("e.g., /home/user/.config/rclone/rclone.conf".to_string()),
                options: None,
                required: Some(false),
                requires_restart: Some(true),
            },
        );

        metadata.insert(
            "core.rclone_path".to_string(),
            SettingMetadata {
                display_name: "Rclone Binary Path".to_string(),
                value_type: "path".to_string(),
                help_text: "Path to rclone binary or directory. Leave empty for auto-detection, use 'system' for system PATH.".to_string(),
                validation_type: Some("frontend:crossPlatformPath".to_string()),
                validation_pattern: None,
                validation_message: Some("Must be a valid file or directory path".to_string()),
                min_value: None,
                max_value: None,
                step: None,
                placeholder: Some("e.g., /usr/bin/rclone or 'system'".to_string()),
                options: None,
                required: Some(false),
                requires_restart: Some(true),
            },
        );

        metadata.insert(
            "core.terminal_apps".to_string(),
            SettingMetadata {
                display_name: "Preferred Terminal Apps".to_string(),
                value_type: "array".to_string(),
                help_text: "List of terminal applications to use for commands.".to_string(),
                validation_type: None,
                validation_pattern: None,
                validation_message: Some("All items must be valid terminal app names".to_string()),
                min_value: None,
                max_value: None,
                step: None,
                placeholder: Some("e.g., gnome-terminal, x-terminal-emulator".to_string()),
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata.insert(
            "experimental.debug_logging".to_string(),
            SettingMetadata {
                display_name: "Enable Debug Logging".to_string(),
                value_type: "bool".to_string(),
                help_text: "Enable detailed logging for debugging.".to_string(),
                validation_type: None,
                validation_pattern: None,
                validation_message: None,
                min_value: None,
                max_value: None,
                step: None,
                placeholder: None,
                options: None,
                required: Some(true),
                requires_restart: Some(false),
            },
        );

        metadata
    }
}
