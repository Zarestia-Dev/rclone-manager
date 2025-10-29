use log::{debug, error};
use once_cell::sync::Lazy;
use serde_json::json;
use tauri::Manager;
use tokio::sync::RwLock;

use crate::{
    core::settings::remote::manager::get_remote_settings,
    rclone::queries::{get_all_remote_configs, get_mounted_remotes, get_remotes},
    utils::types::all_types::{MountedRemote, RemoteCache},
};

// fn redact_sensitive_values(
//     params: &[String],
//     restrict_mode: &Arc<std::sync::RwLock<bool>>,
// ) -> Value {
//     params
//         .iter()
//         .map(|k| {
//             let value = if *restrict_mode.read().unwrap()
//                 && SENSITIVE_KEYS
//                     .iter()
//                     .any(|sk| k.to_lowercase().contains(sk))
//             {
//                 json!("[RESTRICTED]")
//             } else {
//                 json!(k)
//             };
//             (k.clone(), value)
//         })
//         .collect()
// }

// // Recursively redact sensitive values in a serde_json::Value
// fn redact_sensitive_json(value: &Value, restrict_mode: &Arc<std::sync::RwLock<bool>>) -> Value {
//     match value {
//         Value::Object(map) => {
//             let redacted_map = map
//                 .iter()
//                 .map(|(k, v)| {
//                     if *restrict_mode.read().unwrap()
//                         && SENSITIVE_KEYS
//                             .iter()
//                             .any(|sk| k.to_lowercase().contains(sk))
//                     {
//                         (k.clone(), json!("[RESTRICTED]"))
//                     } else {
//                         (k.clone(), redact_sensitive_json(v, restrict_mode))
//                     }
//                 })
//                 .collect();
//             Value::Object(redacted_map)
//         }
//         Value::Array(arr) => Value::Array(
//             arr.iter()
//                 .map(|v| redact_sensitive_json(v, restrict_mode))
//                 .collect(),
//         ),
//         _ => value.clone(),
//     }
// }

pub static CACHE: Lazy<RemoteCache> = Lazy::new(|| RemoteCache {
    remotes: RwLock::new(Vec::new()),
    configs: RwLock::new(json!({})),
    settings: RwLock::new(json!({})),
    mounted: RwLock::new(Vec::new()),
});

impl RemoteCache {
    pub async fn refresh_remote_list(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        let mut remotes = self.remotes.write().await;
        if let Ok(remote_list) = get_remotes(app_handle.state()).await {
            *remotes = remote_list;
            // // Redact sensitive values in the remote list
            // let state = app_handle.state::<RcloneState>();
            // let redacted_remotes = redact_sensitive_values(&remotes, &state.restrict_mode);
            // debug!("🔄 Updated remotes: {redacted_remotes:?}");
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
            // // Redact sensitive values in the remote configs
            // let state = app_handle.state::<RcloneState>();
            // let redacted_configs = redact_sensitive_json(&configs, &state.restrict_mode);
            // debug!("🔄 Updated remotes configs: {redacted_configs:?}");
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

    pub async fn refresh_all(&self, app_handle: tauri::AppHandle) {
        let (res1, res2, res3, res4) = tokio::join!(
            self.refresh_remote_list(app_handle.clone()),
            self.refresh_remote_settings(app_handle.clone()),
            self.refresh_remote_configs(app_handle.clone()),
            self.refresh_mounted_remotes(app_handle.clone()),
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
    }

    pub async fn get_mounted_remotes(&self) -> Vec<MountedRemote> {
        self.mounted.read().await.clone()
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
