// Backend Manager - Simplified single-active-backend architecture
//
// Stores multiple backends, but only one is active at runtime.

use crate::core::settings::AppSettingsManager;
use log::info;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::{
    runtime::RuntimeInfo,
    state::BackendState,
    types::{Backend, BackendInfo},
};

use crate::utils::types::{jobs::JobCache, remotes::RemoteCache};

/// Central manager for rclone backends
pub struct BackendManager {
    /// All configured backends (index 0 is always Local)
    backends: RwLock<Vec<Backend>>,
    /// Index of the currently active backend
    active_index: RwLock<usize>,
    /// Runtime connectivity info (version, os, status) - not persisted
    runtime_info: RwLock<HashMap<String, RuntimeInfo>>,
    /// Per-backend state storage (backend_name → cached state)
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
            backends: RwLock::new(vec![Backend::new_local("Local")]),
            active_index: RwLock::new(0),
            runtime_info: RwLock::new(HashMap::new()),
            per_backend_state: RwLock::new(HashMap::new()),
            remote_cache: Arc::new(RemoteCache::new()),
            job_cache: Arc::new(JobCache::new()),
        }
    }

    /// Get a clone of the active backend
    pub async fn get_active(&self) -> Backend {
        let backends = self.backends.read().await;
        let index = *self.active_index.read().await;
        backends
            .get(index)
            .cloned()
            .unwrap_or_else(Backend::default)
    }

    /// Get the name of the active backend
    pub async fn get_active_name(&self) -> String {
        self.get_active().await.name
    }

    /// Get a specific backend by name
    pub async fn get(&self, name: &str) -> Option<Backend> {
        let backends = self.backends.read().await;
        backends.iter().find(|b| b.name == name).cloned()
    }

    /// List all backends with their active status and runtime info
    pub async fn list_all(&self) -> Vec<BackendInfo> {
        let backends = self.backends.read().await;
        let active_index = *self.active_index.read().await;
        let runtime_cache = self.runtime_info.read().await;

        backends
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let info = BackendInfo::from_backend(b, i == active_index);
                if let Some(runtime) = runtime_cache.get(&b.name) {
                    info.with_runtime_info(
                        runtime.version(),
                        runtime.os(),
                        if runtime.status.is_empty() {
                            None
                        } else {
                            Some(runtime.status.clone())
                        },
                        runtime.config_path(),
                    )
                } else {
                    info
                }
            })
            .collect()
    }

    /// Helper to get the config path of the Local backend
    pub async fn get_local_config_path(&self) -> Result<Option<String>, String> {
        let backend = self.get("Local").await.ok_or_else(
            || crate::localized_error!("backendErrors.backend.notFound", "name" => "Local"),
        )?;
        Ok(backend.config_path.clone())
    }

    pub async fn add(
        &self,
        manager: &AppSettingsManager,
        backend: Backend,
        copy_backend_from: Option<&str>,
        copy_remotes_from: Option<&str>,
    ) -> Result<(), String> {
        let mut backends = self.backends.write().await;

        if backends.iter().any(|b| b.name == backend.name) {
            return Err(format!("Backend '{}' already exists", backend.name));
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
                            .map(|_| {
                                info!(
                                    "📋 Copied {} from '{}' to '{}'",
                                    sub_name, src, backend.name
                                )
                            })
                            .or_else(|e| {
                                log::warn!("Failed to duplicate {} profile: {}", sub_name, e);
                                pm.create(&backend.name)
                            })
                    }
                    None => pm.create(&backend.name),
                }
                .ok();
            }
        };

        // Setup both profiles
        setup_profile("backend", copy_backend_from);
        setup_profile("remotes", copy_remotes_from);

        backends.push(backend);
        Ok(())
    }

    /// Update an existing backend
    pub async fn update(
        &self,
        _manager: &AppSettingsManager,
        name: &str,
        backend: Backend,
    ) -> Result<(), String> {
        let mut backends = self.backends.write().await;

        let index = backends
            .iter()
            .position(|b| b.name == name)
            .ok_or_else(|| format!("Backend '{}' not found", name))?;

        info!("🔄 Updating backend: {}", name);
        backends[index] = backend;
        Ok(())
    }

    /// Remove a backend by name and delete its profiles
    pub async fn remove(&self, manager: &AppSettingsManager, name: &str) -> Result<(), String> {
        if name == "Local" {
            return Err(crate::localized_error!(
                "backendErrors.backend.cannotRemoveLocal"
            ));
        }

        let mut backends = self.backends.write().await;
        let active_index = *self.active_index.read().await;

        let index = backends
            .iter()
            .position(|b| b.name == name)
            .ok_or_else(|| format!("Backend '{}' not found", name))?;

        // Can't remove active backend
        if index == active_index {
            return Err(crate::localized_error!(
                "backendErrors.backend.cannotRemoveActive"
            ));
        }

        info!("➖ Removing backend: {}", name);
        backends.remove(index);

        // Clean up per-backend state
        {
            let mut states = self.per_backend_state.write().await;
            states.remove(name);
        }

        // Delete profiles for "remotes" and "backend"
        if let Ok(remotes_sub) = manager.sub_settings("remotes")
            && let Ok(pm) = remotes_sub.profiles()
            && let Err(e) = pm.delete(name)
        {
            log::warn!("Failed to delete 'remotes' profile for {}: {}", name, e);
        }
        if let Ok(backend_sub) = manager.sub_settings("backend")
            && let Ok(pm) = backend_sub.profiles()
            && let Err(e) = pm.delete(name)
        {
            log::warn!("Failed to delete 'backend' profile for {}: {}", name, e);
        }

        // Adjust active_index if needed
        drop(backends);
        let mut active = self.active_index.write().await;
        if *active > index {
            *active -= 1;
        }

        Ok(())
    }

    /// Switch to a different backend
    pub async fn switch_to(
        &self,
        manager: &AppSettingsManager,
        name: &str,
        scheduler: Option<&crate::core::scheduler::engine::CronScheduler>,
        task_cache: Option<&crate::rclone::state::scheduled_tasks::ScheduledTasksCache>,
    ) -> Result<(), String> {
        let backends = self.backends.read().await;
        let (new_index, is_local) = backends
            .iter()
            .enumerate()
            .find(|(_, b)| b.name == name)
            .map(|(i, b)| (i, b.is_local))
            .ok_or_else(|| format!("Backend '{}' not found", name))?;
        drop(backends);

        let current_name = self.get_active_name().await;

        if current_name != name {
            if let (Some(sched), Some(cache)) = (scheduler, task_cache) {
                let old_tasks = cache.get_tasks_for_backend(&current_name).await;
                for task in &old_tasks {
                    if let Some(job_id_str) = &task.scheduler_job_id
                        && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
                    {
                        let _ = sched.unschedule_task(job_id).await;
                    }
                }
                info!(
                    "⏸️  Unscheduled {} tasks for backend '{}'",
                    old_tasks.len(),
                    current_name
                );
            }

            super::state::save_backend_state(self, &current_name, task_cache).await;

            self.remote_cache.clear_all().await;

            super::state::restore_backend_state(self, name, task_cache).await;

            // LAZY LOADING: Load secrets on-demand if not already loaded
            let mut backends = self.backends.write().await;
            if let Some(backend) = backends.iter_mut().find(|b| b.name == name)
                && backend.password.is_none()
                && backend.config_password.is_none()
            {
                load_backend_secrets(manager, backend);
                log::debug!("🔐 Lazy-loaded secrets for backend on switch: {}", name);
            }
            drop(backends);
        }

        let profile_name = if name == "Local" { "default" } else { name };
        info!("👤 Switching profiles to: {}", profile_name);

        self.switch_sub_settings_profile(manager, "remotes", profile_name)
            .await?;
        self.switch_sub_settings_profile(manager, "backend", profile_name)
            .await?;

        *self.active_index.write().await = new_index;

        crate::rclone::engine::core::set_active_is_local(is_local);

        // Tasks restored for new backend (caller must trigger scheduler reload)
        if let (Some(_), Some(cache)) = (scheduler, task_cache) {
            let task_count = cache.get_tasks_for_backend(name).await.len();
            info!(
                "▶️  Restored {} tasks for backend '{}' (will resched on reload)",
                task_count, name
            );
        }

        info!("🔄 Switched to backend: {} (is_local: {})", name, is_local);

        Ok(())
    }

    /// Generic helper to switch profiles for a sub-setting
    async fn switch_sub_settings_profile(
        &self,
        manager: &AppSettingsManager,
        sub_name: &str,
        profile_name: &str,
    ) -> Result<(), String> {
        if let Ok(sub) = manager.sub_settings(sub_name) {
            // Create profile if needed
            if profile_name != "default"
                && let Ok(pm) = sub.profiles()
                && let Err(e) = pm.create(profile_name)
            {
                // Likely already exists, just warn
                log::warn!(
                    "Failed to ensure profile '{}' for {}: {}",
                    profile_name,
                    sub_name,
                    e
                );
            }

            // Switch profile
            if let Err(e) = sub.switch_profile(profile_name) {
                log::error!(
                    "Failed to switch {} to profile '{}': {}",
                    sub_name,
                    profile_name,
                    e
                );
                return Err(format!("Failed to switch {} profile: {}", sub_name, e));
            }
            log::info!("👤 Switched '{}' to profile: {}", sub_name, profile_name);
            Ok(())
        } else {
            log::error!("Failed to access '{}' sub-settings", sub_name);
            Err(format!("Failed to access '{}' sub-settings", sub_name))
        }
    }

    // ============================================================================
    // Connectivity methods (delegate to connectivity module)
    // ============================================================================

    /// Check connectivity - delegates to connectivity module
    pub async fn check_connectivity(
        &self,
        name: &str,
        client: &reqwest::Client,
    ) -> Result<(String, String), String> {
        super::connectivity::check_connectivity(self, name, client).await
    }

    /// Check connectivity with timeout - delegates to connectivity module
    pub async fn check_connectivity_with_timeout(
        &self,
        name: &str,
        client: &reqwest::Client,
        timeout: std::time::Duration,
    ) -> Result<(String, String), String> {
        super::connectivity::check_connectivity_with_timeout(self, name, client, timeout).await
    }

    /// Ensure connectivity or fallback - delegates to connectivity module
    pub async fn ensure_connectivity_or_fallback(
        &self,
        app: &tauri::AppHandle,
        client: &reqwest::Client,
        timeout: std::time::Duration,
    ) -> Result<(), String> {
        super::connectivity::ensure_connectivity_or_fallback(self, app, client, timeout).await
    }

    /// Check other backends - delegates to connectivity module
    pub async fn check_other_backends(&self, client: &reqwest::Client) {
        super::connectivity::check_other_backends(self, client).await
    }

    // ============================================================================
    // Helper methods for internal module access
    // ============================================================================

    /// Set runtime info for a backend (used by connectivity module)
    pub(super) async fn set_runtime_info(&self, name: &str, info: RuntimeInfo) {
        let mut cache = self.runtime_info.write().await;
        cache.insert(name.to_string(), info);
    }

    pub(super) async fn switch_to_local_index(&self) -> Result<(), String> {
        let index = self
            .backends
            .read()
            .await
            .iter()
            .position(|b| b.name == "Local")
            .ok_or_else(|| "Local backend not found".to_string())?;

        *self.active_index.write().await = index;
        Ok(())
    }

    /// Save backend state internally (used by state module)
    pub(super) async fn save_state(&self, name: &str, state: super::state::BackendState) {
        let mut states = self.per_backend_state.write().await;
        states.insert(name.to_string(), state);
    }

    /// Get backend state (used by state module)
    pub(super) async fn get_state(&self, name: &str) -> super::state::BackendState {
        let states = self.per_backend_state.read().await;
        states.get(name).cloned().unwrap_or_default()
    }

    /// Get the runtime config path for a specific backend
    pub async fn get_runtime_config_path(&self, name: &str) -> Option<String> {
        let cache = self.runtime_info.read().await;
        cache.get(name).and_then(|info| info.config_path())
    }

    /// Update runtime status for a backend (used for error states)
    pub async fn set_runtime_status(&self, name: &str, status: &str) {
        let mut cache = self.runtime_info.write().await;

        // If this is an error status, create new RuntimeInfo with just the error
        // Note: status parameter should already include "error:" prefix if it's an error
        if status.starts_with("error") {
            let error_msg = status.strip_prefix("error:").unwrap_or(status);
            cache.insert(name.to_string(), RuntimeInfo::with_error(error_msg));
        } else {
            // Update status on existing RuntimeInfo or create new one
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

        // Track active backend name for later
        let mut active_name: Option<String> = None;

        for key in keys {
            // Special key for active backend
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

                // Load secrets if this is Local or the active backend
                let is_active_target = active_name.as_ref() == Some(&backend.name);
                if backend.name == "Local" || is_active_target {
                    load_backend_secrets(manager, &mut backend);
                    log::debug!("🔐 Loaded secrets for backend: {}", backend.name);
                }

                if backend.name == "Local" {
                    let _ = self.update(manager, "Local", backend).await;
                } else {
                    let _ = self.add(manager, backend, None, None).await;
                }
            }
        }

        // Determine target backend (Default to Local if none saved)
        let target_backend = active_name.unwrap_or_else(|| {
            log::info!("ℹ️ No active backend saved, defaulting to Local");
            "Local".to_string()
        });

        // Restore active backend or fallback to Local
        if let Err(e) = self.switch_to(manager, &target_backend, None, None).await {
            log::warn!(
                "Failed to restore active backend '{}': {}. Reverting to Local.",
                target_backend,
                e
            );

            // Critical Fallback: If target wasn't Local, try Local now
            if target_backend != "Local"
                && let Err(revert_e) = self.switch_to(manager, "Local", None, None).await
            {
                log::error!("Critical: Failed to revert to Local backend: {}", revert_e);
            }
        } else {
            log::info!("✅ Restored active backend: {}", target_backend);
        }

        Ok(())
    }

    /// Save active backend name to settings
    pub fn save_active_to_settings(manager: &AppSettingsManager, name: &str) -> Result<(), String> {
        let connections = manager
            .sub_settings("connections")
            .map_err(|e| e.to_string())?;

        connections
            .set("_active", &name)
            .map_err(|e| format!("Failed to save active backend: {}", e))?;

        log::debug!("💾 Saved active backend: {}", name);
        Ok(())
    }

    /// Refresh active backend - delegates to cache module
    pub async fn refresh_active_backend(&self, client: &reqwest::Client) -> Result<(), String> {
        super::cache::refresh_active_backend(self, client).await
    }
}

impl Default for BackendManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Load backend secrets from keychain
#[cfg(desktop)]
fn load_backend_secrets(manager: &AppSettingsManager, backend: &mut Backend) {
    if let Some(creds) = manager.credentials() {
        // Load RC API password
        if let Ok(Some(password)) = creds.get(&format!("backend:{}:password", backend.name)) {
            // Only set if username exists
            if backend.username.is_some() {
                backend.password = Some(password);
            }
        }

        // Load config password (for remote encrypted configs)
        if let Ok(Some(config_password)) =
            creds.get(&format!("backend:{}:config_password", backend.name))
        {
            backend.config_password = Some(config_password);
        }
    }
}

/// Load backend secrets (mobile no-op)
#[cfg(not(desktop))]
fn load_backend_secrets(_manager: &AppSettingsManager, _backend: &mut Backend) {
    // Keychain not available on mobile
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

    // FIXME: Update tests to support AppSettingsManager injection
    /*
    #[tokio::test]
    async fn test_add_backend() {
        let manager = BackendManager::new();
        let remote = Backend::new_remote("NAS", "192.168.1.100", 51900);

        manager.add(remote).await.unwrap();

        let backends = manager.list_all().await;
        assert_eq!(backends.len(), 2);
    }
    */

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
}
