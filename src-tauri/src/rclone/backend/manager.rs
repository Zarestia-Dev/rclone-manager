// Backend Manager - Simplified single-active-backend architecture
//
// Stores multiple backends, but only one is active at runtime.

use crate::core::settings::AppSettingsManager;
use log::info;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::{
    runtime::RuntimeInfo,
    state::BackendState,
    types::{Backend, BackendInfo},
};

use crate::utils::types::{jobs::JobCache, remotes::RemoteCache};

/// Inner state that must always be read/written together to avoid index drift.
///
/// Keeping `backends` and `active_index` in the same lock ensures that no
/// caller can observe a stale index after a concurrent add/remove/switch.
struct BackendsState {
    backends: Vec<Backend>,
    active_index: usize,
}

impl BackendsState {
    fn new() -> Self {
        Self {
            backends: vec![Backend::new_local("Local")],
            active_index: 0,
        }
    }

    fn active(&self) -> &Backend {
        // active_index is always kept in bounds by our own write paths
        &self.backends[self.active_index]
    }

    fn active_name(&self) -> &str {
        self.active().name.as_str()
    }

    fn find_index(&self, name: &str) -> Option<usize> {
        self.backends.iter().position(|b| b.name == name)
    }
}

/// Central manager for rclone backends
pub struct BackendManager {
    /// Combined lock for backends list + active index.
    /// Never split these into two locks — see `BackendsState` docs.
    state: RwLock<BackendsState>,
    /// Runtime connectivity info (version, os, status) - not persisted
    runtime_info: RwLock<HashMap<String, RuntimeInfo>>,
    /// Per-backend state storage (`backend_name` → cached state)
    per_backend_state: RwLock<HashMap<String, BackendState>>,
    /// Shared remote cache (for active backend)
    pub remote_cache: Arc<RemoteCache>,
    /// Shared job cache (for active backend)
    pub job_cache: Arc<JobCache>,
}

impl BackendManager {
    /// Create a new manager with just the Local backend
    pub fn new() -> Self {
        Self {
            state: RwLock::new(BackendsState::new()),
            runtime_info: RwLock::new(HashMap::new()),
            per_backend_state: RwLock::new(HashMap::new()),
            remote_cache: Arc::new(RemoteCache::new()),
            job_cache: Arc::new(JobCache::new()),
        }
    }

    /// Get a clone of the active backend
    pub async fn get_active(&self) -> Backend {
        self.state.read().await.active().clone()
    }

    /// Get the name of the active backend
    pub async fn get_active_name(&self) -> String {
        self.state.read().await.active_name().to_string()
    }

    /// Get a specific backend by name
    pub async fn get(&self, name: &str) -> Option<Backend> {
        self.state
            .read()
            .await
            .backends
            .iter()
            .find(|b| b.name == name)
            .cloned()
    }

    /// List all backends with their active status and runtime info
    pub async fn list_all(&self) -> Vec<BackendInfo> {
        let state = self.state.read().await;
        let runtime_cache = self.runtime_info.read().await;

        state
            .backends
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let info = BackendInfo::from_backend(b, i == state.active_index);
                if let Some(runtime) = runtime_cache.get(&b.name) {
                    info.with_runtime_info(
                        runtime.version.clone(),
                        runtime.os.clone(),
                        if runtime.status.is_empty() {
                            None
                        } else {
                            Some(runtime.status.clone())
                        },
                        runtime.config_path.clone(),
                    )
                } else {
                    info
                }
            })
            .collect()
    }

    /// Helper to get the config path of the Local backend
    pub async fn get_local_config_path(&self) -> Result<Option<PathBuf>, String> {
        self.state
            .read()
            .await
            .backends
            .iter()
            .find(|b| b.name == "Local")
            .map(|b| b.config_path.clone())
            .ok_or_else(
                || crate::localized_error!("backendErrors.backend.notFound", "name" => "Local"),
            )
    }

    /// Add a new backend and initialize its settings profiles
    ///
    /// # Arguments
    /// * `manager` - App settings manager to create profiles
    /// * `backend` - Backend connection details
    /// * `copy_backend_from` - Optional source backend to copy 'backend' settings from
    /// * `copy_remotes_from` - Optional source backend to copy 'remotes' settings from
    pub async fn add(
        &self,
        manager: &AppSettingsManager,
        backend: Backend,
        copy_backend_from: Option<&str>,
        copy_remotes_from: Option<&str>,
    ) -> Result<(), String> {
        let mut state = self.state.write().await;

        if state.backends.iter().any(|b| b.name == backend.name) {
            return Err(crate::localized_error!(
                "backendErrors.backend.alreadyExists",
                "name" => &backend.name
            ));
        }

        info!("➕ Adding backend: {}", backend.name);

        let setup_profile = |sub_name: &str, source: Option<&str>| {
            if let Ok(sub) = manager.sub_settings(sub_name)
                && let Ok(pm) = sub.profiles()
            {
                match source {
                    Some(src) => {
                        let src_profile = if src == "Local" { "default" } else { src };
                        pm.duplicate(src_profile, &backend.name)
                            .map(|()| {
                                info!(
                                    "📋 Copied {} from '{}' to '{}'",
                                    sub_name, src, backend.name
                                );
                            })
                            .or_else(|e| {
                                log::warn!("Failed to duplicate {sub_name} profile: {e}");
                                pm.create(&backend.name)
                            })
                    }
                    None => pm.create(&backend.name),
                }
                .ok();
            }
        };

        setup_profile("backend", copy_backend_from);
        setup_profile("remotes", copy_remotes_from);

        state.backends.push(backend);
        Ok(())
    }

    /// Update an existing backend's connection details
    pub async fn update(
        &self,
        _manager: &AppSettingsManager,
        name: &str,
        backend: Backend,
    ) -> Result<(), String> {
        let mut state = self.state.write().await;

        let index = state
            .backends
            .iter()
            .position(|b| b.name == name)
            .ok_or_else(
                || crate::localized_error!("backendErrors.backend.notFound", "name" => name),
            )?;

        info!("🔄 Updating backend: {name}");
        state.backends[index] = backend;
        Ok(())
    }

    /// Remove a backend by name and delete its associated profiles
    pub async fn remove(&self, manager: &AppSettingsManager, name: &str) -> Result<(), String> {
        if name == "Local" {
            return Err(crate::localized_error!(
                "backendErrors.backend.cannotRemoveLocal"
            ));
        }

        let mut state = self.state.write().await;

        let index = state
            .backends
            .iter()
            .position(|b| b.name == name)
            .ok_or_else(
                || crate::localized_error!("backendErrors.backend.notFound", "name" => name),
            )?;

        if index == state.active_index {
            return Err(crate::localized_error!(
                "backendErrors.backend.cannotRemoveActive"
            ));
        }

        info!("➖ Removing backend: {name}");
        state.backends.remove(index);

        // Keep active_index consistent after removal
        if state.active_index > index {
            state.active_index -= 1;
        }

        drop(state);

        // Clean up per-backend state
        self.per_backend_state.write().await.remove(name);

        // Delete settings profiles
        if let Ok(remotes_sub) = manager.sub_settings("remotes")
            && let Ok(pm) = remotes_sub.profiles()
            && let Err(e) = pm.delete(name)
        {
            log::warn!("Failed to delete 'remotes' profile for {name}: {e}");
        }
        if let Ok(backend_sub) = manager.sub_settings("backend")
            && let Ok(pm) = backend_sub.profiles()
            && let Err(e) = pm.delete(name)
        {
            log::warn!("Failed to delete 'backend' profile for {name}: {e}");
        }

        Ok(())
    }

    /// Switch to a different backend and manage its state and profiles
    ///
    /// This handles:
    /// 1. Saving current state (jobs, cache)
    /// 2. Restoring state for the new backend
    /// 3. Switching settings profiles
    ///
    /// Task unscheduling/rescheduling is the caller's responsibility.
    pub async fn switch_to(&self, manager: &AppSettingsManager, name: &str) -> Result<(), String> {
        // Single read: capture everything we need atomically
        let (new_index, is_local, current_name) = {
            let state = self.state.read().await;
            let new_index = state.find_index(name).ok_or_else(
                || crate::localized_error!("backendErrors.backend.notFound", "name" => name),
            )?;
            let is_local = state.backends[new_index].is_local;
            let current_name = state.active_name().to_string();
            (new_index, is_local, current_name)
        };

        if current_name != name {
            super::state::save_backend_state(self, &current_name).await;
            self.remote_cache.clear_all().await;
            super::state::restore_backend_state(self, name).await;
        }

        let profile_name = if name == "Local" { "default" } else { name };
        info!("👤 Switching profiles to: {profile_name}");

        self.switch_sub_settings_profile(manager, "remotes", profile_name)?;
        self.switch_sub_settings_profile(manager, "backend", profile_name)?;

        // Brief write: only flip the index, all heavy work is already done
        self.state.write().await.active_index = new_index;

        info!("🔄 Switched to backend: {name} (is_local: {is_local})");
        Ok(())
    }

    /// Generic helper to switch profiles for a sub-setting
    fn switch_sub_settings_profile(
        &self,
        manager: &AppSettingsManager,
        sub_name: &str,
        profile_name: &str,
    ) -> Result<(), String> {
        if let Ok(sub) = manager.sub_settings(sub_name) {
            if profile_name != "default"
                && let Ok(pm) = sub.profiles()
                && let Err(e) = pm.create(profile_name)
            {
                log::warn!("Failed to ensure profile '{profile_name}' for {sub_name}: {e}");
            }

            if let Err(e) = sub.switch_profile(profile_name) {
                log::error!("Failed to switch {sub_name} to profile '{profile_name}': {e}");
                return Err(format!("Failed to switch {sub_name} profile: {e}"));
            }
            log::info!("👤 Switched '{sub_name}' to profile: {profile_name}");
            Ok(())
        } else {
            log::error!("Failed to access '{sub_name}' sub-settings");
            Err(format!("Failed to access '{sub_name}' sub-settings"))
        }
    }

    // ============================================================================
    // Internal helpers (visible to sibling modules in rclone::backend)
    // ============================================================================

    /// Set runtime info for a backend (used by connectivity module)
    pub(super) async fn set_runtime_info(&self, name: &str, info: RuntimeInfo) {
        // Update runtime cache
        self.runtime_info
            .write()
            .await
            .insert(name.to_string(), info.clone());
    }

    /// Save backend state internally (used by state module)
    pub(super) async fn save_state(&self, name: &str, state: BackendState) {
        self.per_backend_state
            .write()
            .await
            .insert(name.to_string(), state);
    }

    /// Get backend state (used by state module)
    pub(super) async fn get_state(&self, name: &str) -> BackendState {
        self.per_backend_state
            .read()
            .await
            .get(name)
            .cloned()
            .unwrap_or_default()
    }

    /// Get the runtime OS for a specific backend
    pub async fn get_runtime_os(&self, name: &str) -> Option<String> {
        self.runtime_info
            .read()
            .await
            .get(name)
            .and_then(|info| info.os.clone())
    }

    /// Get the runtime config path for a specific backend
    pub async fn get_runtime_config_path(&self, name: &str) -> Option<PathBuf> {
        self.runtime_info
            .read()
            .await
            .get(name)
            .and_then(|info| info.config_path.clone())
    }

    /// Update runtime status for a backend (used for error states)
    pub async fn set_runtime_status(&self, name: &str, status: &str) {
        let mut cache = self.runtime_info.write().await;
        if status.starts_with("error") {
            let error_msg = status.strip_prefix("error:").unwrap_or(status);
            cache.insert(name.to_string(), RuntimeInfo::with_error(error_msg));
        } else {
            cache
                .entry(name.to_string())
                .or_insert_with(RuntimeInfo::new)
                .status = status.to_string();
        }
    }

    /// Load backends from settings
    pub async fn load_from_settings(&self, manager: &AppSettingsManager) -> Result<(), String> {
        let connections = manager
            .sub_settings("connections")
            .map_err(|e| e.to_string())?;

        let keys = connections.list().map_err(|e| e.to_string())?;

        let mut active_name: Option<String> = None;

        for key in keys {
            if key == "_active" {
                if let Ok(value) = connections.get_value(&key) {
                    active_name = value.as_str().map(String::from);
                }
                continue;
            }

            if let Ok(value) = connections.get_value(&key)
                && let Ok(mut backend) = serde_json::from_value::<Backend>(value)
            {
                backend.name = key.clone();

                if backend.name == "Local" {
                    let _ = self.update(manager, "Local", backend).await;
                } else {
                    let _ = self.add(manager, backend, None, None).await;
                }
            }
        }

        let target_backend = active_name.unwrap_or_else(|| {
            log::info!("ℹ️ No active backend saved, defaulting to Local");
            "Local".to_string()
        });

        if let Err(e) = self.switch_to(manager, &target_backend).await {
            log::warn!(
                "Failed to restore active backend '{target_backend}': {e}. Reverting to Local."
            );
            if target_backend != "Local"
                && let Err(revert_e) = self.switch_to(manager, "Local").await
            {
                log::error!("Critical: Failed to revert to Local backend: {revert_e}");
            }
        } else {
            log::info!("✅ Restored active backend: {target_backend}");
        }

        Ok(())
    }

    /// Persist the active backend name to settings.
    ///
    /// Logs a warning on failure; callers should not treat this as fatal.
    pub fn save_active_to_settings(manager: &AppSettingsManager, name: &str) {
        let result = (|| -> Result<(), String> {
            let connections = manager
                .sub_settings("connections")
                .map_err(|e| e.to_string())?;
            connections
                .set("_active", &name)
                .map_err(|e| format!("Failed to save active backend: {e}"))
        })();

        match result {
            Ok(()) => log::debug!("💾 Saved active backend: {name}"),
            Err(e) => log::warn!("Failed to persist active backend '{name}': {e}"),
        }
    }
}

impl Default for BackendManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_new_manager() {
        let manager = BackendManager::new();
        let backends = manager.list_all().await;
        assert_eq!(backends.len(), 1);
        assert_eq!(backends[0].name, "Local");
        assert!(backends[0].is_active);
    }

    #[tokio::test]
    async fn test_set_runtime_status() {
        let manager = BackendManager::new();
        manager.set_runtime_status("Local", "connected").await;

        let backends = manager.list_all().await;
        assert_eq!(backends[0].status, Some("connected".to_string()));

        manager
            .set_runtime_status("Local", "error:connection failed")
            .await;
        let backends = manager.list_all().await;
        assert_eq!(
            backends[0].status,
            Some("error:connection failed".to_string())
        );
    }

    #[tokio::test]
    async fn test_get_active_name_consistent() {
        // Both reads come from the same lock, so they can never disagree.
        let manager = BackendManager::new();
        assert_eq!(manager.get_active_name().await, "Local");
        assert_eq!(manager.get_active().await.name, "Local");
    }
}
