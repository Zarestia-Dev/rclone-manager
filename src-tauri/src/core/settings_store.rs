use serde::{Deserialize, Serialize};

/// App settings structure
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub tray_enabled: bool,
    pub start_minimized: bool,
    pub auto_refresh: bool,
    pub notifications: bool,
    pub rclone_api_port: u16,
    pub default_mount_type: String,
    pub debug_logging: bool,
    pub bandwidth_limit: String,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct RemoteSettings {
    pub key: String,
    pub value: String,
}

// ✅ Default values
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            tray_enabled: true,
            start_minimized: false,
            auto_refresh: true,
            notifications: true,
            rclone_api_port: 5572,
            default_mount_type: "native".to_string(),
            debug_logging: false,
            bandwidth_limit: "".to_string(),
        }
    }
}