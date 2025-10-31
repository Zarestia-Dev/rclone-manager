use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
