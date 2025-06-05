// use regex::Regex;
use std::collections::HashMap;

use crate::utils::types::{AppSettings, CoreSettings, ExperimentalSettings, GeneralSettings, SettingMetadata};

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
                connection_check_urls:
                    "https://www.google.com;https://www.dropbox.com;https://onedrive.live.com"
                        .to_string(),
                // default_mount_type: "native".to_string(),
                bandwidth_limit: "".to_string(),
                rclone_config_path: "".to_string(),
                completed_onboarding: false,
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
                validation_pattern: None,
                validation_message: None,
                options: None,
                required: Some(true),
            },
        );

        metadata.insert(
            "general.notifications".to_string(),
            SettingMetadata {
                display_name: "Enable Notifications".to_string(),
                value_type: "bool".to_string(),
                help_text: "Show notifications for mount events.".to_string(),
                validation_pattern: None,
                validation_message: None,
                options: None,
                required: Some(true),
            },
        );

        metadata.insert(
            "general.tray_enabled".to_string(),
            SettingMetadata {
                display_name: "Enable Tray Icon".to_string(),
                value_type: "bool".to_string(),
                help_text: "Show an icon in the system tray. Also enables the background service."
                .to_string(),
                validation_pattern: None,
                validation_message: None,
                options: None,
                required: Some(true),
            },
        );

        metadata.insert(
            "general.restrict".to_string(),
            SettingMetadata {
                display_name: "Restrict Values".to_string(),
                value_type: "bool".to_string(),
                help_text: "Restrict some specific values for security purposes (e.g., Token, Client ID, etc.)"
                    .to_string(),
                validation_pattern: None,
                validation_message: None,
                options: None,
                required: Some(true),
            },
        );

        metadata.insert(
            "core.bandwidth_limit".to_string(),
            SettingMetadata {
                display_name: "Bandwidth Limit".to_string(),
                value_type: "string".to_string(),
                help_text: "Limit the bandwidth used by Rclone transfers. It can be specified as 'upload:download'".to_string(),
                validation_pattern: Some(r"^(\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*)(:\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*|)?$".to_string()),
                validation_message: Some("The bandwidth should be of the form 1M|2M|1G|1K|1.1K etc. Can also be specified as (upload:download). Keep it empty for no limit.".to_string()),
                options: None,
                required: Some(false),
            },
        );
        
        metadata.insert(
            "core.rclone_api_port".to_string(),
            SettingMetadata {
                display_name: "Rclone API Port".to_string(),
                value_type: "number".to_string(),
                help_text: "Port used for Rclone API communication (1024-65535).".to_string(),
                validation_pattern: Some(
                    r"^(?:[1-9]\d{3,4}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$"
                    .to_string(),
                ),
                validation_message: Some(
                    "Must be a valid port number between 1024 and 65535".to_string(),
                ),
                options: None,
                required: Some(true),
            },
        );
        
        metadata.insert(
            "core.rclone_oauth_port".to_string(),
            SettingMetadata {
                display_name: "Rclone OAuth Port".to_string(),
                value_type: "number".to_string(),
                help_text: "Port used for Rclone OAuth communication (1024-65535).".to_string(),
                validation_pattern: Some(
                    r"^(?:[1-9]\d{3,4}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$"
                    .to_string(),
                ),
                validation_message: Some(
                    "Must be a valid port number between 1024 and 65535".to_string(),
                ),
                options: None,
                required: Some(true),
            },
        );
        
        metadata.insert(
            "core.connection_check_urls".to_string(),
            SettingMetadata {
                display_name: "Connection Check URLs".to_string(),
                value_type: "string".to_string(),
                help_text: "Semicolon-separated list of URLs to check for internet connectivity (e.g., https://link1;http://link2)".to_string(),
                validation_pattern: Some(r"^(https?://[^\s;]+)(;https?://[^\s;]+)*$".to_string()),
                validation_message: Some("Must be valid URLs separated by semicolons".to_string()),
                options: None,
                required: Some(true),
                
            },
        );
        
        metadata.insert(
            "core.max_tray_items".to_string(),
            SettingMetadata {
                display_name: "Max Tray Items".to_string(),
                value_type: "number".to_string(),
                help_text: "Maximum number of items to show in the tray (1-40).".to_string(),
                validation_pattern: Some(r"^(?:[1-9]|[1-3][0-9]|40)$".to_string()),
                validation_message: Some("Must be between 1 and 40".to_string()),
                options: None,
                required: Some(true),
            },
        );
                
        metadata.insert(
            "core.completed_onboarding".to_string(),
            SettingMetadata {
                display_name: "Completed Onboarding".to_string(),
                value_type: "bool".to_string(),
                help_text: "Indicates if the onboarding process is completed.".to_string(),
                validation_pattern: None,
                validation_message: None,
                options: None,
                required: Some(true),
            },
        );

        metadata.insert(
            "core.rclone_config_path".to_string(),
            SettingMetadata {
                display_name: "Rclone Config Path".to_string(),
                value_type: "string".to_string(),
                help_text: "Path to rclone config file. Leave empty to use default location.".to_string(),
                validation_pattern: None,
                validation_message: None,
                options: None,
                required: Some(false),
            },
        );

        metadata.insert(
            "experimental.debug_logging".to_string(),
            SettingMetadata {
                display_name: "Enable Debug Logging".to_string(),
                value_type: "bool".to_string(),
                help_text: "Enable detailed logging for debugging.".to_string(),
                validation_pattern: None,
                validation_message: None,
                options: None,
                required: Some(true),
            },
        );

        // metadata.insert(
        //     "core.default_mount_type".to_string(),
        //     SettingMetadata {
        //         display_name: "Default Mount Type".to_string(),
        //         value_type: "string".to_string(),
        //         help_text: "Choose between 'native' or 'systemd' mount methods.".to_string(),
        //     },
        // );


        metadata
    }
}
