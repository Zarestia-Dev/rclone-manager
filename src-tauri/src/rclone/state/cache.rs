use crate::{
    core::settings::AppSettingsManager,
    rclone::queries::{get_all_remote_configs, get_mounted_remotes, get_remotes, list_serves},
};

use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::RwLock;

use crate::utils::types::{
    events::{MOUNT_STATE_CHANGED, SERVE_STATE_CHANGED},
    remotes::{MountedRemote, RemoteCache, ServeInstance},
};

/// Persistent context for RemoteCache — saved/restored on backend switches so that
/// profile associations (embedded in the structs) survive the transition.
#[derive(Debug, Clone, Default)]
pub struct RemoteCacheContext {
    pub mounts: Vec<MountedRemote>,
    pub serves: Vec<ServeInstance>,
}

impl RemoteCache {
    pub fn new() -> Self {
        Self {
            remotes: RwLock::new(Vec::new()),
            configs: RwLock::new(json!({})),
            mounted: RwLock::new(Vec::new()),
            serves: RwLock::new(Vec::new()),
        }
    }

    /// Clear ALL cache data (remotes, configs, mounts, serves).
    /// Called when switching backends to ensure no stale data remains.
    /// Profiles are preserved via get_context/set_context, which snapshots the vecs.
    pub async fn clear_all(&self) {
        self.remotes.write().await.clear();
        *self.configs.write().await = json!({});
        self.mounted.write().await.clear();
        self.serves.write().await.clear();
    }

    /// Snapshot the current mounts and serves (including embedded profiles) for
    /// later restoration when returning to this backend.
    pub async fn get_context(&self) -> RemoteCacheContext {
        RemoteCacheContext {
            mounts: self.mounted.read().await.clone(),
            serves: self.serves.read().await.clone(),
        }
    }

    /// Restore a previously saved context. The background watcher will reconcile
    /// against the live API shortly after, carrying profiles forward via the merge logic.
    pub async fn set_context(&self, context: RemoteCacheContext) {
        *self.mounted.write().await = context.mounts;
        *self.serves.write().await = context.serves;
    }

    // =========================================================================
    // PROFILE MERGE HELPERS
    // These carry the profile field forward from the existing cache entry when the
    // rclone API (which has no concept of profiles) returns fresh data.
    // =========================================================================

    fn merge_mount_profiles(
        incoming: Vec<MountedRemote>,
        existing: &[MountedRemote],
    ) -> Vec<MountedRemote> {
        incoming
            .into_iter()
            .map(|mut m| {
                m.profile = existing
                    .iter()
                    .find(|e| e.mount_point == m.mount_point)
                    .and_then(|e| e.profile.clone());
                m
            })
            .collect()
    }

    fn merge_serve_profiles(
        incoming: Vec<ServeInstance>,
        existing: &[ServeInstance],
    ) -> Vec<ServeInstance> {
        incoming
            .into_iter()
            .map(|mut s| {
                s.profile = existing
                    .iter()
                    .find(|e| e.id == s.id)
                    .and_then(|e| e.profile.clone());
                s
            })
            .collect()
    }

    // =========================================================================
    // REACTIVE CACHE UPDATES — emit events only when data actually changes
    // =========================================================================

    /// Update mounted remotes cache and emit event if changed.
    /// Carries profiles forward from the existing cache. Returns true if changed.
    pub async fn update_mounts_if_changed(
        &self,
        new_mounts: Vec<MountedRemote>,
        app_handle: &AppHandle,
    ) -> bool {
        let mut cache = self.mounted.write().await;
        let merged = Self::merge_mount_profiles(new_mounts, &cache);
        if *cache == merged {
            return false;
        }
        *cache = merged;
        drop(cache);

        info!("📡 Mount cache changed");
        let _ = app_handle.emit(MOUNT_STATE_CHANGED, "cache_updated");
        true
    }

    /// Update serves cache and emit event if changed.
    /// Carries profiles forward from the existing cache. Returns true if changed.
    pub async fn update_serves_if_changed(
        &self,
        new_serves: Vec<ServeInstance>,
        app_handle: &AppHandle,
    ) -> bool {
        let mut cache = self.serves.write().await;
        let merged = Self::merge_serve_profiles(new_serves, &cache);
        if *cache == merged {
            return false;
        }
        *cache = merged;
        drop(cache);

        info!("📡 Serve cache changed");
        let _ = app_handle.emit(SERVE_STATE_CHANGED, "cache_updated");
        true
    }

    // =========================================================================
    // FULL REFRESH — called on startup / backend switch
    // =========================================================================

    pub async fn refresh_remote_list(&self, app: AppHandle) -> Result<(), String> {
        match get_remotes(app).await {
            Ok(remote_list) => {
                *self.remotes.write().await = remote_list;
                Ok(())
            }
            Err(_) => {
                error!("Failed to fetch remotes");
                Err(crate::localized_error!(
                    "backendErrors.cache.fetchRemotesFailed"
                ))
            }
        }
    }

    pub async fn refresh_remote_configs(&self, app: AppHandle) -> Result<(), String> {
        match get_all_remote_configs(app).await {
            Ok(remote_list) => {
                *self.configs.write().await = remote_list;
                Ok(())
            }
            Err(_) => {
                error!("Failed to fetch remotes config");
                Err(crate::localized_error!(
                    "backendErrors.cache.fetchConfigFailed"
                ))
            }
        }
    }

    pub async fn refresh_mounted_remotes(&self, app: AppHandle) -> Result<(), String> {
        match get_mounted_remotes(app).await {
            Ok(remotes) => {
                let mut mounted = self.mounted.write().await;
                let existing = mounted.clone();
                *mounted = Self::merge_mount_profiles(remotes, &existing);
                debug!("🔄 Updated mounted remotes cache");
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

    pub async fn refresh_serves(&self, app: AppHandle) -> Result<(), String> {
        match list_serves(app).await {
            Ok(serves) => {
                let mut cache_serves = self.serves.write().await;
                let existing = cache_serves.clone();
                *cache_serves = Self::merge_serve_profiles(serves, &existing);
                debug!(
                    "🔄 Updated serves cache: {} active serves",
                    cache_serves.len()
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

    #[allow(clippy::type_complexity)]
    pub async fn refresh_all(&self, app: AppHandle) -> Result<(), String> {
        let (r1, r2, r3, r4) = tokio::join!(
            self.refresh_remote_list(app.clone()),
            self.refresh_remote_configs(app.clone()),
            self.refresh_mounted_remotes(app.clone()),
            self.refresh_serves(app.clone()),
        );

        for (label, res) in [
            ("remote list", r1),
            ("remote configs", r2),
            ("mounted remotes", r3),
            ("serves", r4),
        ] {
            if let Err(e) = res {
                error!("Failed to refresh {label}: {e}");
            }
        }

        Ok(())
    }

    // =========================================================================
    // POINT MUTATIONS — called immediately after a mount/serve operation succeeds
    // =========================================================================

    /// Write a profile directly onto the matching mount cache entry.
    /// Must be called AFTER force_check_mounted_remotes so the entry exists.
    pub async fn store_mount_profile(&self, mount_point: &str, profile: Option<String>) {
        let mut mounts = self.mounted.write().await;
        if let Some(m) = mounts.iter_mut().find(|m| m.mount_point == mount_point) {
            debug!("📌 Stored mount profile: {mount_point} -> {profile:?}");
            m.profile = profile;
        }
    }

    /// Write a profile directly onto the matching serve cache entry.
    /// Must be called AFTER force_check_serves so the entry exists.
    pub async fn store_serve_profile(&self, serve_id: &str, profile: Option<String>) {
        let mut serves = self.serves.write().await;
        if let Some(s) = serves.iter_mut().find(|s| s.id == serve_id) {
            debug!("📌 Stored serve profile: {serve_id} -> {profile:?}");
            s.profile = profile;
        }
    }

    // =========================================================================
    // READS
    // =========================================================================

    pub async fn get_mounted_remotes(&self) -> Vec<MountedRemote> {
        self.mounted.read().await.clone()
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

    pub async fn get_mount_profile(&self, mount_point: &str) -> Option<String> {
        self.mounted
            .read()
            .await
            .iter()
            .find(|m| m.mount_point == mount_point)
            .and_then(|m| m.profile.clone())
    }

    pub async fn get_serve_profile(&self, serve_id: &str) -> Option<String> {
        self.serves
            .read()
            .await
            .iter()
            .find(|s| s.id == serve_id)
            .and_then(|s| s.profile.clone())
    }

    // =========================================================================
    // PROFILE RENAME — called when a profile is renamed in settings
    // =========================================================================

    /// Rename a profile in all mounted remotes for a given remote.
    pub async fn rename_profile_in_mounts(
        &self,
        remote_name: &str,
        old_name: &str,
        new_name: &str,
    ) -> usize {
        let mut mounts = self.mounted.write().await;
        let mut count = 0;
        for mount in mounts.iter_mut() {
            if mount.fs.starts_with(remote_name) && mount.profile.as_deref() == Some(old_name) {
                mount.profile = Some(new_name.to_string());
                count += 1;
            }
        }
        count
    }

    /// Rename a profile in all serves for a given remote.
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
            if fs_matches && serve.profile.as_deref() == Some(old_name) {
                serve.profile = Some(new_name.to_string());
                count += 1;
            }
        }
        count
    }
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn get_cached_remotes<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, String> {
    use crate::rclone::backend::BackendManager;
    Ok(app
        .state::<BackendManager>()
        .remote_cache
        .get_remotes()
        .await)
}

#[tauri::command]
pub async fn get_configs<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    use crate::rclone::backend::BackendManager;
    Ok(app
        .state::<BackendManager>()
        .remote_cache
        .get_configs()
        .await)
}

/// Get all remote settings from rcman sub-settings
#[tauri::command]
pub async fn get_settings<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    use crate::rclone::backend::BackendManager;
    use serde_json::json;

    let manager = app.state::<AppSettingsManager>();
    let remotes = manager
        .inner()
        .sub_settings("remotes")
        .map_err(|e| format!("Failed to get remotes sub-settings: {e}"))?;

    let backend_manager = app.state::<BackendManager>();
    let remote_names = backend_manager.remote_cache.get_remotes().await;
    let mut all_settings = serde_json::Map::new();

    for remote_name in remote_names {
        if let Ok(settings) = remotes.get_value(&remote_name) {
            all_settings.insert(remote_name, settings);
        }
    }

    Ok(json!(all_settings))
}

#[tauri::command]
pub async fn get_cached_mounted_remotes<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<MountedRemote>, String> {
    use crate::rclone::backend::BackendManager;
    Ok(app
        .state::<BackendManager>()
        .remote_cache
        .get_mounted_remotes()
        .await)
}

#[tauri::command]
pub async fn get_cached_serves<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ServeInstance>, String> {
    use crate::rclone::backend::BackendManager;
    Ok(app
        .state::<BackendManager>()
        .remote_cache
        .get_serves()
        .await)
}

/// Rename a profile in all cached mounts
#[tauri::command]
pub async fn rename_mount_profile_in_cache<R: Runtime>(
    app: AppHandle<R>,
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    use crate::rclone::backend::BackendManager;
    let updated = app
        .state::<BackendManager>()
        .remote_cache
        .rename_profile_in_mounts(&remote_name, &old_name, &new_name)
        .await;

    if updated > 0 {
        let _ = app.emit(MOUNT_STATE_CHANGED, "cache_updated");
    }

    Ok(updated)
}

/// Rename a profile in all cached serves
#[tauri::command]
pub async fn rename_serve_profile_in_cache<R: Runtime>(
    app: AppHandle<R>,
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    use crate::rclone::backend::BackendManager;
    let updated = app
        .state::<BackendManager>()
        .remote_cache
        .rename_profile_in_serves(&remote_name, &old_name, &new_name)
        .await;

    if updated > 0 {
        let _ = app.emit(SERVE_STATE_CHANGED, "cache_updated");
    }

    Ok(updated)
}

impl Default for RemoteCache {
    fn default() -> Self {
        Self::new()
    }
}
