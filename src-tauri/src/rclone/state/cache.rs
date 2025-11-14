use log::{debug, error};
use serde_json::json;
use tauri::{Manager, State};
use tokio::sync::RwLock;

use crate::{
    core::settings::remote::manager::get_remote_settings,
    rclone::queries::{get_all_remote_configs, get_mounted_remotes, get_remotes, list_serves},
    utils::types::all_types::{MountedRemote, RemoteCache, ServeInstance},
};

impl RemoteCache {
    pub fn new() -> Self {
        Self {
            remotes: RwLock::new(Vec::new()),
            configs: RwLock::new(json!({})),
            settings: RwLock::new(json!({})),
            mounted: RwLock::new(Vec::new()),
            serves: RwLock::new(Vec::new()),
        }
    }

    pub async fn refresh_remote_list(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        let mut remotes = self.remotes.write().await;
        if let Ok(remote_list) = get_remotes(app_handle.state()).await {
            *remotes = remote_list;
            Ok(())
        } else {
            error!("Failed to fetch remotes");
            Err("Failed to fetch remotes".into())
        }
    }

    pub async fn refresh_remote_configs(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        let mut configs = self.configs.write().await;
        if let Ok(remote_list) = get_all_remote_configs(app_handle.state()).await {
            *configs = remote_list;
            Ok(())
        } else {
            error!("Failed to fetch remotes config");
            Err("Failed to fetch remotes config".into())
        }
    }

    pub async fn refresh_remote_settings(
        &self,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        let remotes: Vec<String> = {
            let remotes_guard = self.remotes.read().await;
            remotes_guard.clone() // Quick clone, release lock
        };

        let mut all_settings = serde_json::Map::new();
        for remote in remotes {
            // IO without holding cache locks
            if let Ok(settings) = get_remote_settings(remote.clone(), app_handle.state()).await {
                all_settings.insert(remote, settings);
            }
        }

        // Brief write lock only for the final update
        let mut settings = self.settings.write().await;
        *settings = serde_json::Value::Object(all_settings);
        Ok(())
    }

    pub async fn refresh_mounted_remotes(
        &self,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        match get_mounted_remotes(app_handle.state()).await {
            Ok(remotes) => {
                let mut mounted = self.mounted.write().await;
                *mounted = remotes;
                debug!("🔄 Updated mounted remotes cache");
                Ok(())
            }
            Err(e) => {
                error!("❌ Failed to refresh mounted remotes: {e}");
                Err("Failed to refresh mounted remotes".into())
            }
        }
    }

    pub async fn refresh_all(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        let (res1, res2, res3, res4, res5) = tokio::join!(
            self.refresh_remote_list(app_handle.clone()),
            self.refresh_remote_settings(app_handle.clone()),
            self.refresh_remote_configs(app_handle.clone()),
            self.refresh_mounted_remotes(app_handle.clone()),
            self.refresh_serves(app_handle.clone()),
        );

        if let Err(e) = res1 {
            error!("Failed to refresh remote list: {e}");
        }
        if let Err(e) = res2 {
            error!("Failed to refresh remote settings: {e}");
        }
        if let Err(e) = res3 {
            error!("Failed to refresh remote configs: {e}");
        }
        if let Err(e) = res4 {
            error!("Failed to refresh mounted remotes: {e}");
        }
        if let Err(e) = res5 {
            error!("Failed to refresh serves: {e}");
        }

        Ok(())
    }

    pub async fn get_mounted_remotes(&self) -> Vec<MountedRemote> {
        self.mounted.read().await.clone()
    }

    pub async fn refresh_serves(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        match list_serves(app_handle.state()).await {
            Ok(response) => {
                let serves_list = response
                    .get("list")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| {
                                let id = item.get("id")?.as_str()?.to_string();
                                let addr = item.get("addr")?.as_str()?.to_string();
                                let params = item.get("params")?.clone();

                                Some(ServeInstance { id, addr, params })
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                let mut serves = self.serves.write().await;
                *serves = serves_list;
                debug!("🔄 Updated serves cache: {} active serves", serves.len());
                Ok(())
            }
            Err(e) => {
                error!("❌ Failed to refresh serves: {e}");
                Err("Failed to refresh serves".into())
            }
        }
    }

    pub async fn get_serves(&self) -> Vec<ServeInstance> {
        self.serves.read().await.clone()
    }

    pub async fn get_remotes(&self) -> Vec<String> {
        self.remotes.read().await.clone()
    }

    pub async fn get_configs(&self) -> serde_json::Value {
        self.configs.read().await.clone()
    }

    pub async fn get_settings(&self) -> serde_json::Value {
        self.settings.read().await.clone()
    }
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn get_cached_remotes(cache: State<'_, RemoteCache>) -> Result<Vec<String>, String> {
    Ok(cache.get_remotes().await)
}

#[tauri::command]
pub async fn get_configs(cache: State<'_, RemoteCache>) -> Result<serde_json::Value, String> {
    Ok(cache.get_configs().await)
}

#[tauri::command]
pub async fn get_settings(cache: State<'_, RemoteCache>) -> Result<serde_json::Value, String> {
    Ok(cache.get_settings().await)
}

#[tauri::command]
pub async fn get_cached_mounted_remotes(
    cache: State<'_, RemoteCache>,
) -> Result<Vec<MountedRemote>, String> {
    Ok(cache.get_mounted_remotes().await)
}

#[tauri::command]
pub async fn get_cached_serves(
    cache: State<'_, RemoteCache>,
) -> Result<Vec<ServeInstance>, String> {
    Ok(cache.get_serves().await)
}
