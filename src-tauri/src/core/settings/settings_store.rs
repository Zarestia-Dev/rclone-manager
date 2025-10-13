// use regex::Regex;
use std::collections::HashMap;

use crate::utils::types::all_types::{
    AppSettings, CoreSettings, ExperimentalSettings, GeneralSettings, SettingMetadata,
};

/// Macro to create SettingMetadata with only required and commonly used fields
/// This reduces boilerplate and makes the code more readable
macro_rules! setting_meta {
    (
        $display_name:expr,
        $value_type:expr,
        $help_text:expr
        $(, validation_type = $validation_type:expr)?
        $(, validation_message = $validation_message:expr)?
        $(, min = $min_value:expr)?
        $(, max = $max_value:expr)?
        $(, step = $step:expr)?
        $(, placeholder = $placeholder:expr)?
        $(, required = $required:expr)?
        $(, requires_restart = $requires_restart:expr)?
        $(, group = $group:expr)?
        $(, depends_on = $depends_on:expr)?
        $(, depends_value = $depends_value:expr)?
    ) => {
        SettingMetadata {
            display_name: $display_name.to_string(),
            value_type: $value_type.to_string(),
            help_text: $help_text.to_string(),
            validation_type: None $(.or(Some($validation_type.to_string())))?,
            validation_pattern: None,
            validation_message: None $(.or(Some($validation_message.to_string())))?,
            min_value: None $(.or(Some($min_value)))?,
            max_value: None $(.or(Some($max_value)))?,
            step: None $(.or(Some($step)))?,
            placeholder: None $(.or(Some($placeholder.to_string())))?,
            options: None,
            required: None $(.or(Some($required)))?,
            requires_restart: None $(.or(Some($requires_restart)))?        }
    };
}

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
                rclone_config_file: "".to_string(),
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

impl AppSettings {
    pub fn get_metadata() -> HashMap<String, SettingMetadata> {
        let mut metadata = HashMap::new();

        // General Settings (App-level)
        metadata.insert(
            "general.start_on_startup".to_string(),
            setting_meta!(
                "Start on Startup",
                "bool",
                "Automatically start the app when the system starts.",
                required = true,
                requires_restart = false
            ),
        );

        metadata.insert(
            "general.notifications".to_string(),
            setting_meta!(
                "Enable Notifications",
                "bool",
                "Show notifications for mount events.",
                required = true,
                requires_restart = false
            ),
        );

        metadata.insert(
            "general.tray_enabled".to_string(),
            setting_meta!(
                "Enable Tray Icon",
                "bool",
                "Show an icon in the system tray. Also enables the background service.",
                required = true,
                requires_restart = false
            ),
        );

        metadata.insert(
            "general.restrict".to_string(),
            setting_meta!(
                "Restrict Values",
                "bool",
                "Restrict some specific values for security purposes (e.g., Token, Client ID, etc.)",
                required = true,
                requires_restart = false
            ),
        );

        // RClone Settings - Network Group
        metadata.insert(
            "core.bandwidth_limit".to_string(),
            setting_meta!(
                "Bandwidth Limit",
                "string",
                "Limit the bandwidth used by Rclone transfers. It can be specified as 'upload:download'",
                validation_type = "frontend:bandwidthFormat",
                validation_message = "The bandwidth should be of the form 1M|2M|1G|1K|1.1K etc. Can also be specified as (upload:download). Keep it empty for no limit.",
                placeholder = "e.g., 10M or 5M:2M",
                required = false,
                requires_restart = false
            ),
        );

        // RClone Settings - Engine Group
        metadata.insert(
            "core.rclone_api_port".to_string(),
            setting_meta!(
                "Rclone API Port",
                "number",
                "Port used for Rclone API communication (1024-65535).",
                validation_type = "frontend:portRange",
                validation_message = "Must be a valid port number between 1024 and 65535",
                min = 1024,
                max = 65535,
                step = 1,
                placeholder = "e.g., 51900",
                required = true,
                requires_restart = true
            ),
        );

        metadata.insert(
            "core.rclone_oauth_port".to_string(),
            setting_meta!(
                "Rclone OAuth Port",
                "number",
                "Port used for Rclone OAuth communication (1024-65535).",
                validation_type = "frontend:portRange",
                validation_message = "Must be a valid port number between 1024 and 65535",
                min = 1024,
                max = 65535,
                step = 1,
                placeholder = "e.g., 51901",
                required = true,
                requires_restart = false
            ),
        );

        metadata.insert(
            "core.connection_check_urls".to_string(),
            setting_meta!(
                "Connection Check URLs",
                "array",
                "List of URLs to check for internet connectivity",
                validation_type = "frontend:urlList",
                validation_message = "All items must be valid URLs",
                placeholder = "https://google.com",
                required = true,
                requires_restart = false
            ),
        );

        // App-level Core Settings (no group = appears in Preferences)
        metadata.insert(
            "core.max_tray_items".to_string(),
            setting_meta!(
                "Max Tray Items",
                "number",
                "Maximum number of items to show in the tray (1-40).",
                validation_type = "frontend:trayItemsRange",
                validation_message = "Must be between 1 and 40",
                min = 1,
                max = 40,
                step = 1,
                placeholder = "e.g., 5",
                required = true,
                requires_restart = false
            ),
        );

        metadata.insert(
            "core.completed_onboarding".to_string(),
            setting_meta!(
                "Completed Onboarding",
                "bool",
                "Indicates if the onboarding process is completed.",
                required = true,
                requires_restart = false
            ),
        );

        // RClone Settings - Paths Group
        metadata.insert(
            "core.rclone_config_file".to_string(),
            setting_meta!(
                "Rclone Config File",
                "file",
                "Path to rclone config file. Leave empty to use default location.",
                validation_type = "frontend:crossPlatformPath",
                validation_message = "Must be a valid file path",
                placeholder = "e.g., /home/user/.config/rclone/rclone.conf",
                required = false,
                requires_restart = true
            ),
        );

        metadata.insert(
            "core.rclone_path".to_string(),
            setting_meta!(
                "Rclone Binary Path",
                "folder",
                "Path to rclone binary or directory. Leave empty for auto-detection, use 'system' for system PATH.",
                validation_type = "frontend:crossPlatformPath",
                validation_message = "Must be a valid file or directory path",
                placeholder = "e.g., /usr/bin/rclone or 'system'",
                required = false,
                requires_restart = true
            ),
        );

        metadata.insert(
            "core.terminal_apps".to_string(),
            setting_meta!(
                "Preferred Terminal Apps",
                "array",
                "List of terminal applications to use for commands.",
                validation_message = "All items must be valid terminal app names",
                placeholder = "e.g., gnome-terminal, x-terminal-emulator",
                required = true,
                requires_restart = false
            ),
        );

        metadata.insert(
            "core.rclone_path".to_string(),
            setting_meta!(
                "Rclone Binary Path",
                "folder",
                "Path to rclone binary or directory. Leave empty for auto-detection, use 'system' for system PATH.",
                validation_type = "frontend:crossPlatformPath",
                validation_message = "Must be a valid file or directory path",
                placeholder = "e.g., /usr/bin/rclone or 'system'",
                required = false,
                requires_restart = true
            ),
        );

        metadata.insert(
            "core.terminal_apps".to_string(),
            setting_meta!(
                "Preferred Terminal Apps",
                "array",
                "List of terminal applications to use for commands.",
                validation_message = "All items must be valid terminal app names",
                placeholder = "e.g., gnome-terminal, x-terminal-emulator",
                required = true,
                requires_restart = false
            ),
        );
        // Experimental Settings
        metadata.insert(
            "experimental.debug_logging".to_string(),
            setting_meta!(
                "Enable Debug Logging",
                "bool",
                "Enable detailed logging for debugging.",
                required = true,
                requires_restart = false
            ),
        );

        metadata
    }
}
