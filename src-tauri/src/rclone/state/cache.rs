use rcman::JsonSettingsManager;
use std::collections::HashMap;

use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::{
    rclone::{
        backend::BACKEND_MANAGER,
        backend::types::Backend,
        queries::{
            get_all_remote_configs_internal, get_mounted_remotes_internal, get_remotes_internal,
            list_serves_internal, parse_serves_response,
        },
    },
    utils::types::{
        MountedRemote, RemoteCache, ServeInstance,
        events::{MOUNT_STATE_CHANGED, SERVE_STATE_CHANGED},
    },
};

impl RemoteCache {
    /// Clear only remotes and configs (refresh from backend)
    /// but preserve mounts/serves state
    pub async fn clear_remotes_only(&self) {
        let mut remotes = self.remotes.write().await;
        remotes.clear();
        let mut configs = self.configs.write().await;
        *configs = json!({});
    }

    /// Get mounts/serves state (for per-backend storage)
    pub async fn get_backend_state(
        &self,
    ) -> (
        Vec<MountedRemote>,
        Vec<ServeInstance>,
        HashMap<String, String>,
        HashMap<String, String>,
    ) {
        let mounted = self.mounted.read().await.clone();
        let serves = self.serves.read().await.clone();
        let mount_profiles = self.mount_profiles.read().await.clone();
        let serve_profiles = self.serve_profiles.read().await.clone();
        (mounted, serves, mount_profiles, serve_profiles)
    }

    /// Set mounts/serves state (for per-backend restore)
    pub async fn set_backend_state(
        &self,
        mounted: Vec<MountedRemote>,
        serves: Vec<ServeInstance>,
        mount_profiles: HashMap<String, String>,
        serve_profiles: HashMap<String, String>,
    ) {
        let mut m = self.mounted.write().await;
        *m = mounted;
        let mut s = self.serves.write().await;
        *s = serves;
        let mut mp = self.mount_profiles.write().await;
        *mp = mount_profiles;
        let mut sp = self.serve_profiles.write().await;
        *sp = serve_profiles;
    }

    // =========================================================================
    // REACTIVE CACHE UPDATES - Emit events only when data actually changes
    // =========================================================================

    /// Update mounted remotes cache and emit event if changed.
    /// Attaches profiles automatically. Returns true if changed.
    pub async fn update_mounts_if_changed(
        &self,
        new_mounts: Vec<MountedRemote>,
        app_handle: &AppHandle,
    ) -> bool {
        // Attach profiles
        let profiles = self.mount_profiles.read().await;
        let enriched: Vec<MountedRemote> = new_mounts
            .into_iter()
            .map(|mut m| {
                m.profile = profiles.get(&m.mount_point).cloned();
                m
            })
            .collect();
        drop(profiles);

        // Compare and update
        let mut cache = self.mounted.write().await;
        if *cache == enriched {
            return false;
        }
        *cache = enriched;
        drop(cache);

        // Emit
        info!("📡 Mount cache changed");
        let _ = app_handle.emit(MOUNT_STATE_CHANGED, "cache_updated");
        true
    }

    /// Update serves cache and emit event if changed.
    /// Attaches profiles automatically. Returns true if changed.
    pub async fn update_serves_if_changed(
        &self,
        new_serves: Vec<ServeInstance>,
        app_handle: &AppHandle,
    ) -> bool {
        // Attach profiles
        let profiles = self.serve_profiles.read().await;
        let enriched: Vec<ServeInstance> = new_serves
            .into_iter()
            .map(|mut s| {
                s.profile = profiles.get(&s.id).cloned();
                s
            })
            .collect();
        drop(profiles);

        // Compare and update
        let mut cache = self.serves.write().await;
        if *cache == enriched {
            return false;
        }
        *cache = enriched;
        drop(cache);

        // Emit
        info!("📡 Serve cache changed");
        let _ = app_handle.emit(SERVE_STATE_CHANGED, "cache_updated");
        true
    }

    pub fn new() -> Self {
        Self {
            remotes: RwLock::new(Vec::new()),
            configs: RwLock::new(json!({})),
            mounted: RwLock::new(Vec::new()),
            serves: RwLock::new(Vec::new()),
            mount_profiles: RwLock::new(HashMap::new()),
            serve_profiles: RwLock::new(HashMap::new()),
        }
    }

    pub async fn refresh_remote_list(
        &self,
        client: &reqwest::Client,
        backend: &Backend,
    ) -> Result<(), String> {
        let mut remotes = self.remotes.write().await;
        if let Ok(remote_list) = get_remotes_internal(client, backend).await {
            *remotes = remote_list;
            Ok(())
        } else {
            error!("Failed to fetch remotes");
            Err(crate::localized_error!(
                "backendErrors.cache.fetchRemotesFailed"
            ))
        }
    }

    pub async fn refresh_remote_configs(
        &self,
        client: &reqwest::Client,
        backend: &Backend,
    ) -> Result<(), String> {
        let mut configs = self.configs.write().await;
        if let Ok(remote_list) = get_all_remote_configs_internal(client, backend).await {
            *configs = remote_list;
            Ok(())
        } else {
            error!("Failed to fetch remotes config");
            Err(crate::localized_error!(
                "backendErrors.cache.fetchConfigFailed"
            ))
        }
    }

    pub async fn refresh_mounted_remotes(
        &self,
        client: &reqwest::Client,
        backend: &Backend,
    ) -> Result<(), String> {
        match get_mounted_remotes_internal(client, backend).await {
            Ok(mut remotes) => {
                // Attach profiles from our lookup table
                let profiles = self.mount_profiles.read().await;
                for mount in remotes.iter_mut() {
                    mount.profile = profiles.get(&mount.mount_point).cloned();
                }
                drop(profiles);

                // Also clean up stale entries from mount_profiles
                let active_mount_points: std::collections::HashSet<_> =
                    remotes.iter().map(|m| m.mount_point.clone()).collect();
                let mut profiles_mut = self.mount_profiles.write().await;
                profiles_mut.retain(|mount_point, _| active_mount_points.contains(mount_point));
                drop(profiles_mut);

                let mut mounted = self.mounted.write().await;
                *mounted = remotes;
                debug!("🔄 Updated mounted remotes cache with profiles");
                Ok(())
            }
            Err(e) => {
                error!("❌ Failed to refresh mounted remotes: {e}");
                Err(crate::localized_error!(
                    "backendErrors.cache.refreshMountsFailed"
                ))
            }
        }
    }

    /// Store a mount profile mapping (call this when mounting)
    pub async fn store_mount_profile(&self, mount_point: &str, profile: Option<String>) {
        if let Some(profile_name) = profile {
            let mut profiles = self.mount_profiles.write().await;
            profiles.insert(mount_point.to_string(), profile_name);
            debug!(
                "📌 Stored mount profile: {} -> {}",
                mount_point,
                profiles.get(mount_point).unwrap_or(&"?".to_string())
            );
        }
    }

    #[allow(clippy::type_complexity)]
    pub async fn refresh_all(
        &self,
        client: &reqwest::Client,
        backend: &Backend,
    ) -> Result<(), String> {
        let (res1, res2, res3, res4): (
            Result<(), String>,
            Result<(), String>,
            Result<(), String>,
            Result<(), String>,
        ) = tokio::join!(
            self.refresh_remote_list(client, backend),
            self.refresh_remote_configs(client, backend),
            self.refresh_mounted_remotes(client, backend),
            self.refresh_serves(client, backend),
        );

        if let Err(e) = res1 {
            error!("Failed to refresh remote list: {e}");
        }
        if let Err(e) = res2 {
            error!("Failed to refresh remote configs: {e}");
        }
        if let Err(e) = res3 {
            error!("Failed to refresh mounted remotes: {e}");
        }
        if let Err(e) = res4 {
            error!("Failed to refresh serves: {e}");
        }

        Ok(())
    }

    pub async fn get_mounted_remotes(&self) -> Vec<MountedRemote> {
        self.mounted.read().await.clone()
    }

    pub async fn refresh_serves(
        &self,
        client: &reqwest::Client,
        backend: &Backend,
    ) -> Result<(), String> {
        match list_serves_internal(client, backend).await {
            Ok(response) => {
                let mut serves_list = parse_serves_response(&response);

                // Attach profiles from our lookup table
                let profiles = self.serve_profiles.read().await;
                for serve in serves_list.iter_mut() {
                    serve.profile = profiles.get(&serve.id).cloned();
                }
                drop(profiles);

                // Clean up stale entries from serve_profiles
                let active_serve_ids: std::collections::HashSet<_> =
                    serves_list.iter().map(|s| s.id.clone()).collect();
                let mut profiles_mut = self.serve_profiles.write().await;
                profiles_mut.retain(|serve_id, _| active_serve_ids.contains(serve_id));
                drop(profiles_mut);

                let mut serves = self.serves.write().await;
                *serves = serves_list;
                debug!(
                    "🔄 Updated serves cache with profiles: {} active serves",
                    serves.len()
                );
                Ok(())
            }
            Err(e) => {
                error!("❌ Failed to refresh serves: {e}");
                Err(crate::localized_error!(
                    "backendErrors.cache.refreshServesFailed"
                ))
            }
        }
    }

    pub async fn get_serves(&self) -> Vec<ServeInstance> {
        self.serves.read().await.clone()
    }

    /// Store a serve profile mapping (call this when starting serve)
    pub async fn store_serve_profile(&self, serve_id: &str, profile: Option<String>) {
        if let Some(profile_name) = profile {
            let mut profiles = self.serve_profiles.write().await;
            profiles.insert(serve_id.to_string(), profile_name);
            debug!(
                "📌 Stored serve profile: {} -> {}",
                serve_id,
                profiles.get(serve_id).unwrap_or(&"?".to_string())
            );
        }
    }

    pub async fn get_remotes(&self) -> Vec<String> {
        let guard = self.remotes.read().await;
        let v: Vec<String> = guard.clone();
        v
    }

    pub async fn get_configs(&self) -> serde_json::Value {
        self.configs.read().await.clone()
    }

    // === Profile Management for Mounts ===
    /// Rename a profile in all mounted remotes for a given remote
    pub async fn rename_profile_in_mounts(
        &self,
        remote_name: &str,
        old_name: &str,
        new_name: &str,
    ) -> usize {
        let mut mounts = self.mounted.write().await;
        let mut count = 0;
        for mount in mounts.iter_mut() {
            if mount.fs.starts_with(remote_name)
                && mount.profile.as_ref().is_some_and(|p| p == old_name)
            {
                mount.profile = Some(new_name.to_string());
                count += 1;
            }
        }
        count
    }

    // === Profile Management for Serves ===
    /// Rename a profile in all serves for a given remote
    pub async fn rename_profile_in_serves(
        &self,
        remote_name: &str,
        old_name: &str,
        new_name: &str,
    ) -> usize {
        let mut serves = self.serves.write().await;
        let mut count = 0;
        for serve in serves.iter_mut() {
            let fs_matches = serve
                .params
                .get("fs")
                .and_then(|v| v.as_str())
                .is_some_and(|fs| fs.starts_with(remote_name));
            if fs_matches && serve.profile.as_ref().is_some_and(|p| p == old_name) {
                serve.profile = Some(new_name.to_string());
                count += 1;
            }
        }
        count
    }
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn get_cached_remotes() -> Result<Vec<String>, String> {
    Ok(BACKEND_MANAGER.remote_cache.get_remotes().await)
}

#[tauri::command]
pub async fn get_configs() -> Result<serde_json::Value, String> {
    Ok(BACKEND_MANAGER.remote_cache.get_configs().await)
}

/// Get all remote settings from rcman sub-settings
#[tauri::command]
pub async fn get_settings(
    manager: tauri::State<'_, JsonSettingsManager>,
) -> Result<serde_json::Value, String> {
    use serde_json::json;

    let remotes = manager
        .inner()
        .sub_settings("remotes")
        .map_err(|e| format!("Failed to get remotes sub-settings: {e}"))?;

    let remote_names = BACKEND_MANAGER.remote_cache.get_remotes().await;
    let mut all_settings = serde_json::Map::new();

    for remote_name in remote_names {
        if let Ok(settings) = remotes.get_value(&remote_name) {
            all_settings.insert(remote_name, settings);
        }
    }

    Ok(json!(all_settings))
}

#[tauri::command]
pub async fn get_cached_mounted_remotes() -> Result<Vec<MountedRemote>, String> {
    Ok(BACKEND_MANAGER.remote_cache.get_mounted_remotes().await)
}

#[tauri::command]
pub async fn get_cached_serves() -> Result<Vec<ServeInstance>, String> {
    Ok(BACKEND_MANAGER.remote_cache.get_serves().await)
}

/// Rename a profile in all cached mounts
#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn rename_mount_profile_in_cache(
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    Ok(BACKEND_MANAGER
        .remote_cache
        .rename_profile_in_mounts(&remote_name, &old_name, &new_name)
        .await)
}

/// Rename a profile in all cached serves
#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn rename_serve_profile_in_cache(
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    Ok(BACKEND_MANAGER
        .remote_cache
        .rename_profile_in_serves(&remote_name, &old_name, &new_name)
        .await)
}

impl Default for RemoteCache {
    fn default() -> Self {
        Self::new()
    }
}
