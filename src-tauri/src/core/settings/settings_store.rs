use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 🛠️ Metadata for settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SettingMetadata {
    pub display_name: String,
    pub value_type: String, // "bool", "u16", "string"
    pub help_text: String,
}

/// General settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeneralSettings {
    pub tray_enabled: bool,
    pub start_on_startup: bool,
    pub notifications: bool,
}

/// Core settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CoreSettings {
    pub max_tray_items: usize,
    pub rclone_api_port: u16,
    pub rclone_oauth_port: u16,
    pub default_mount_type: String,
    pub bandwidth_limit: String,
    pub completed_onboarding: bool,
}

/// Experimental settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExperimentalSettings {
    pub debug_logging: bool,
}

/// The complete settings model
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub core: CoreSettings,
    pub experimental: ExperimentalSettings,
}

/// ✅ Default settings
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            general: GeneralSettings {
                tray_enabled: true,
                start_on_startup: false,
                notifications: true,
            },
            core: CoreSettings {
                max_tray_items: 5,
                rclone_api_port: 5572,
                rclone_oauth_port: 5580,
                default_mount_type: "native".to_string(),
                bandwidth_limit: "".to_string(),
                completed_onboarding: false,
            },
            experimental: ExperimentalSettings {
                debug_logging: false,
            },
        }
    }
}

/// ✅ Get settings metadata (doesn't store this in the file)
impl AppSettings {
    pub fn get_metadata() -> HashMap<String, SettingMetadata> {
        let mut metadata = HashMap::new();

        metadata.insert(
            "general.tray_enabled".to_string(),
            SettingMetadata {
                display_name: "Enable Tray Icon".to_string(),
                value_type: "bool".to_string(),
                help_text: "Show an icon in the system tray. Also enables the background service.".to_string(),
            },
        );

        metadata.insert(
            "general.start_on_startup".to_string(),
            SettingMetadata {
                display_name: "Start on Startup".to_string(),
                value_type: "bool".to_string(),
                help_text: "Automatically start the app when the system starts.".to_string(),
            },
        );

        metadata.insert(
            "general.notifications".to_string(),
            SettingMetadata {
                display_name: "Enable Notifications".to_string(),
                value_type: "bool".to_string(),
                help_text: "Show notifications for mount events.".to_string(),
            },
        );

        metadata.insert(
            "core.max_tray_items".to_string(),
            SettingMetadata {
                display_name: "Max Tray Items".to_string(),
                value_type: "number".to_string(),
                help_text: "Maximum number of items to show in the tray.".to_string(),
            },
        );

        metadata.insert(
            "core.rclone_api_port".to_string(),
            SettingMetadata {
                display_name: "Rclone API Port".to_string(),
                value_type: "number".to_string(),
                help_text: "Port used for Rclone API communication.".to_string(),
            },
        );

        metadata.insert(
            "core.rclone_oauth_port".to_string(),
            SettingMetadata {
                display_name: "Rclone OAuth Port".to_string(),
                value_type: "number".to_string(),
                help_text: "Port used for Rclone OAuth communication.".to_string(),
            },
        );

        metadata.insert(
            "core.default_mount_type".to_string(),
            SettingMetadata {
                display_name: "Default Mount Type".to_string(),
                value_type: "string".to_string(),
                help_text: "Choose between 'native' or 'systemd' mount methods.".to_string(),
            },
        );

        metadata.insert(
            "core.bandwidth_limit".to_string(),
            SettingMetadata {
                display_name: "Bandwidth Limit".to_string(),
                value_type: "string".to_string(),
                help_text: "Limit the bandwidth used by Rclone transfers.".to_string(),
            },
        );

        metadata.insert(
            "core.completed_onboarding".to_string(),
            SettingMetadata {
                display_name: "Completed Onboarding".to_string(),
                value_type: "bool".to_string(),
                help_text: "Indicates if the onboarding process is completed.".to_string(),
            },
        );

        metadata.insert(
            "experimental.debug_logging".to_string(),
            SettingMetadata {
                display_name: "Enable Debug Logging".to_string(),
                value_type: "bool".to_string(),
                help_text: "Enable detailed logging for debugging.".to_string(),
            },
        );

        metadata
    }
}
