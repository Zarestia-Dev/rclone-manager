use log::{debug, error};
use once_cell::sync::Lazy;
use serde_json::json;
use std::sync::Mutex;
use tauri::Manager;
use tokio::sync::RwLock;

use crate::core::settings::settings::get_remote_settings;

use super::api_query::{get_all_remote_configs, get_mounted_remotes, get_remotes, MountedRemote};

#[derive(Debug)]
pub struct RcloneState {
    pub api_url: Mutex<String>,
    pub api_port: Mutex<u16>,
    pub oauth_url: Mutex<String>,
    pub oauth_port: Mutex<u16>,
}

pub static RCLONE_STATE: Lazy<RcloneState> = Lazy::new(|| RcloneState {
    api_url: Mutex::new(String::new()),
    api_port: Mutex::new(5572),
    oauth_url: Mutex::new(String::new()),
    oauth_port: Mutex::new(5580),
});

impl RcloneState {
    pub fn set_api(&self, url: String, port: u16) -> Result<(), String> {
        *self.api_url.lock().map_err(|e| e.to_string())? = url;
        *self.api_port.lock().map_err(|e| e.to_string())? = port;
        Ok(())
    }    

    pub fn get_api(&self) -> (String, u16) {
        (
            self.api_url.lock().unwrap().clone(),
            *self.api_port.lock().unwrap(),
        )
    }

    pub fn set_oauth(&self, url: String, port: u16) -> Result<(), String> {
        *self.oauth_url.lock().map_err(|e| e.to_string())? = url;
        *self.oauth_port.lock().map_err(|e| e.to_string())? = port;
        Ok(())
    }

    pub fn get_oauth(&self) -> (String, u16) {
        (
            self.oauth_url.lock().unwrap().clone(),
            *self.oauth_port.lock().unwrap(),
        )
    }
}

pub struct RemoteCache {
    pub remotes: RwLock<Vec<String>>,
    pub configs: RwLock<serde_json::Value>,
    pub settings: RwLock<serde_json::Value>,
    pub mounted: RwLock<Vec<MountedRemote>>
}

pub static CACHE: Lazy<RemoteCache> = Lazy::new(|| RemoteCache {
    remotes: RwLock::new(Vec::new()),
    configs: RwLock::new(json!({})),
    settings: RwLock::new(json!({})),
    mounted: RwLock::new(Vec::new()),
});

impl RemoteCache {
    // pub fn new() -> Self {
    //     Self {
    //         remotes: RwLock::new(Vec::new()),
    //         configs: RwLock::new(json!({})),
    //         settings: RwLock::new(json!({})),
    //     }
    // }

    pub async fn refresh_remote_list(&self, app_handle: tauri::AppHandle) {
        let mut remotes = self.remotes.write().await;
        if let Ok(remote_list) = get_remotes(app_handle.state()).await {
            *remotes = remote_list;
            debug!("🔄 Updated remotes: {:?}", *remotes);
        } else {
            error!("Failed to fetch remotes");
        }
    }
    pub async fn refresh_remote_configs(&self, app_handle: tauri::AppHandle) {
        let mut configs = self.configs.write().await;
        if let Ok(remote_list) = get_all_remote_configs(app_handle.state()).await {
            *configs = remote_list;
            debug!("🔄 Updated remotes config: {:?}", *configs);
        } else {
            error!("Failed to fetch remotes config");
        }
    }
    pub async fn refresh_remote_settings(&self, app_handle: tauri::AppHandle) {
        let remotes = self.remotes.read().await;
        let mut settings = self.settings.write().await;

        let mut all_settings = serde_json::Map::new();

        for remote in remotes.iter() {
            if let Ok(settings) = get_remote_settings(remote.to_string(), app_handle.state()).await
            {
                all_settings.insert(remote.clone(), settings);
            } else {
                error!("❌ Failed to fetch settings for remote: {}", remote);
            }
        }

        *settings = serde_json::Value::Object(all_settings);
        debug!("🔄 Updated remotes settings cache");
    }
    pub async fn refresh_mounted_remotes(&self, app_handle: tauri::AppHandle) {
        match get_mounted_remotes(app_handle.state()).await {
            Ok(remotes) => {
                let mut mounted = self.mounted.write().await;
                *mounted = remotes;
                debug!("🔄 Updated mounted remotes cache");
            }
            Err(e) => {
                error!("❌ Failed to refresh mounted remotes: {}", e);
            }
        }
    }

    pub async fn refresh_all(&self, app_handle: tauri::AppHandle) {
        self.refresh_remote_list(app_handle.clone()).await;
        self.refresh_remote_configs(app_handle.clone()).await;
        self.refresh_remote_settings(app_handle.clone()).await;
        self.refresh_mounted_remotes(app_handle.clone()).await;
    }
}

#[tauri::command]
pub async fn get_cached_remotes() -> Result<Vec<String>, String> {
    Ok(CACHE.remotes.read().await.clone())
}

#[tauri::command]
pub async fn get_configs() -> Result<serde_json::Value, String> {
    Ok(CACHE.configs.read().await.clone())
}

#[tauri::command]
pub async fn get_settings() -> Result<serde_json::Value, String> {
    Ok(CACHE.settings.read().await.clone())
}

#[tauri::command]
pub async fn get_cached_mounted_remotes() -> Result<Vec<MountedRemote>, String> {
    Ok(CACHE.mounted.read().await.clone())
}