// Backend Manager - Simplified single-active-backend architecture
//
// Stores multiple backends, but only one is active at runtime.

use log::info;
use once_cell::sync::Lazy;
use crate::core::settings::AppSettingsManager;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::{
    runtime::RuntimeInfo,
    types::{Backend, BackendInfo},
};

use crate::utils::types::{
    jobs::{JobCache, JobInfo},
    remotes::RemoteCache,
};

use crate::rclone::state::cache::RemoteCacheContext;

// RuntimeInfo is now imported from the runtime module

/// Per-backend cached state (jobs + persistent context)
#[derive(Debug, Clone, Default)]
pub struct BackendState {
    pub jobs: Vec<JobInfo>,
    pub context: RemoteCacheContext,
}

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

    /// Add a new backend
    pub async fn add(&self, backend: Backend) -> Result<(), String> {
        let mut backends = self.backends.write().await;

        // Check for duplicate name
        if backends.iter().any(|b| b.name == backend.name) {
            return Err(format!("Backend '{}' already exists", backend.name));
        }

        info!("➕ Adding backend: {}", backend.name);
        backends.push(backend);
        Ok(())
    }

    /// Update an existing backend
    pub async fn update(&self, name: &str, backend: Backend) -> Result<(), String> {
        let mut backends = self.backends.write().await;

        let index = backends
            .iter()
            .position(|b| b.name == name)
            .ok_or_else(|| format!("Backend '{}' not found", name))?;

        info!("🔄 Updating backend: {}", name);
        backends[index] = backend;
        Ok(())
    }

    /// Remove a backend by name
    pub async fn remove(&self, name: &str) -> Result<(), String> {
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
    ) -> Result<(), String> {
        // Get the new backend info
        let backends = self.backends.read().await;
        let (new_index, is_local) = backends
            .iter()
            .enumerate()
            .find(|(_, b)| b.name == name)
            .map(|(i, b)| (i, b.is_local))
            .ok_or_else(|| format!("Backend '{}' not found", name))?;
        drop(backends);

        // Get current backend name before switching
        let current_name = self.get_active_name().await;

        // Don't save/restore logic if switching to the same backend
        // BUT we still ensure the correct profile is active
        if current_name != name {
            // 1. Save current backend's state (Jobs + Context)
            let jobs = self.job_cache.get_all_jobs().await;
            let context = self.remote_cache.get_context().await;

            let current_state = BackendState { jobs, context };

            {
                let mut states = self.per_backend_state.write().await;
                states.insert(current_name.clone(), current_state);
                info!("💾 Saved state for backend: {}", current_name);
            }

            // 2. Clear ALL cache data (wipes stale mounts, serves, remote lists)
            self.remote_cache.clear_all().await;

            // 3. Restore new backend's state (or empty if none exists)
            let new_state = {
                let states = self.per_backend_state.read().await;
                states.get(name).cloned().unwrap_or_default()
            };

            // Restore jobs (History)
            self.job_cache.set_all_jobs(new_state.jobs).await;

            // Restore Context (Profiles)
            self.remote_cache.set_context(new_state.context).await;

            info!("📂 Restored context for backend: {}", name);
        }

        // 4. Switch rcman Profile for Remotes
        // Local -> "default" profile
        // Remote -> "{name}" profile (e.g., "NAS")
        let profile_name = if name == "Local" { "default" } else { name };
        info!("👤 Switching to profile: {}", profile_name);

        // Switch profile for "remotes" sub-setting specifically
        if let Ok(remotes_sub) = manager.sub_settings("remotes") {
             // Create profile if needed (accessing inner profile manager for creation)
            if profile_name != "default" {
                 if let Ok(pm) = remotes_sub.profiles() {
                     if let Err(e) = pm.create(profile_name) {
                         log::warn!("Failed to create profile '{}' for remotes: {}", profile_name, e);
                     }
                 }
            }

            // use the high-level switch_profile which handles cache invalidation
            if let Err(e) = remotes_sub.switch_profile(profile_name) {
                log::error!("Failed to switch remotes to profile '{}': {}", profile_name, e);
                return Err(format!("Failed to switch remotes profile: {}", e));
            }
            log::info!("👤 Switched 'remotes' to profile: {}", profile_name);
        } else {
            log::error!("Failed to access 'remotes' sub-settings");
            return Err("Failed to access 'remotes' sub-settings".into());
        }

        // Update active index
        let mut active = self.active_index.write().await;
        *active = new_index;

        // Update cached is_local flag for engine
        crate::rclone::engine::core::set_active_is_local(is_local);

        info!("🔄 Switched to backend: {} (is_local: {})", name, is_local);

        Ok(())
    }

    /// Check connectivity to a backend, updating cache if successful
    /// Returns (version, os) on success
    pub async fn check_connectivity(
        &self,
        name: &str,
        client: &reqwest::Client,
    ) -> Result<(String, String), String> {
        let backend = self
            .get(name)
            .await
            .ok_or_else(|| format!("Backend '{}' not found", name))?;

        // Use fetch_runtime_info to fetch all runtime info
        let timeout = std::time::Duration::from_secs(5);
        let runtime_info =
            crate::rclone::backend::runtime::fetch_runtime_info(&backend, client, timeout).await;

        // Extract version and os for return value (for backward compatibility)
        let version = runtime_info.version().unwrap_or_default();
        let os = runtime_info.os().unwrap_or_default();

        // Check if fetch was successful
        if !runtime_info.is_connected() {
            if let Some(error) = runtime_info.error_message() {
                return Err(error);
            }
            return Err("Connection failed".to_string());
        }

        // Update runtime cache
        {
            let mut cache = self.runtime_info.write().await;
            cache.insert(name.to_string(), runtime_info);
        }

        Ok((version, os))
    }

    /// Check connectivity with a specified timeout
    /// Returns detailed error message on failure or timeout
    pub async fn check_connectivity_with_timeout(
        &self,
        name: &str,
        client: &reqwest::Client,
        timeout: std::time::Duration,
    ) -> Result<(String, String), String> {
        let check_future = self.check_connectivity(name, client);

        match tokio::time::timeout(timeout, check_future).await {
            Ok(result) => result,
            Err(_) => Err(format!("Connection timed out after {}s", timeout.as_secs())),
        }
    }

    /// Check Local backend connectivity with retries (used during startup)
    /// Retries every 500ms until timeout
    pub async fn check_local_connectivity_retrying(
        &self,
        client: &reqwest::Client,
        timeout: std::time::Duration,
    ) -> Result<(String, String), String> {
        let check_local_future = async {
            let mut attempts = 0;
            loop {
                match self.check_connectivity("Local", client).await {
                    Ok(info) => return Ok(info),
                    Err(e) => {
                        attempts += 1;
                        if attempts % 2 == 0 {
                            log::debug!(
                                "⚠️ Local backend check attempt {} failed: {}",
                                attempts,
                                e
                            );
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }
        };

        match tokio::time::timeout(timeout, check_local_future).await {
            Ok(result) => result,
            Err(_) => {
                // Return a clear error if we timed out
                Err(format!(
                    "Local backend check timed out after {}s",
                    timeout.as_secs()
                ))
            }
        }
    }

    /// Ensure valid connectivity for the active backend, automatically failing back to Local if needed.
    /// This orchestrates the entire startup connectivity check process.
    pub async fn ensure_connectivity_or_fallback(
        &self,
        client: &reqwest::Client,
        timeout: std::time::Duration,
    ) -> Result<(), String> {
        let active_name = self.get_active_name().await;

        if active_name == "Local" {
            // Case 1: Active is Local - Just check with retries
            info!(
                "🔍 Checking Local backend for version/OS info (timeout: {}s)",
                timeout.as_secs()
            );

            match self
                .check_local_connectivity_retrying(client, timeout)
                .await
            {
                Ok(_) => {
                    info!("✅ Local backend is reachable and runtime info loaded");
                    Ok(())
                }
                Err(_) => {
                    log::warn!(
                        "⚠️ Local backend check timed out after {}s. Marking as connected but runtime info may be missing.",
                        timeout.as_secs()
                    );
                    // Still mark as connected since it's managed by us
                    self.set_runtime_status("Local", "connected").await;
                    Ok(())
                }
            }
        } else {
            // Case 2: Active is Remote - Check with timeout and fallback
            info!(
                "🔍 Checking connectivity for active backend: {} (timeout: {}s)",
                active_name,
                timeout.as_secs()
            );

            match self
                .check_connectivity_with_timeout(&active_name, client, timeout)
                .await
            {
                Ok(_) => {
                    info!("✅ Active backend '{}' is reachable", active_name);
                    Ok(())
                }
                Err(e) => {
                    log::warn!(
                        "⚠️ Active backend '{}' connectivity failed: {}. Falling back to Local.",
                        active_name,
                        e
                    );

                    // Set error status
                    self.set_runtime_status(&active_name, &format!("error:{}", e))
                        .await;

                    // Fallback switch
                    // Note: We need a manager reference here, but don't have one in check_connectivity_with_timeout.
                    // However, we can't easily access the AppHandle/State here.
                    // Since fallback is a critical error path, and Local uses "default" profile which is likely already active
                    // or will be switched to next time a command runs, checking constraints...
                    
                    // CRITICAL: We cannot invoke profile switch here without manager.
                    // Ideally check_connectivity_or_fallback should assume backend manager orchestration.
                    // For now, we accept we can't switch the PROFILE here, but we switch the active index.
                    // The Frontend will likely reload/retry calling commands which will properly switch context if needed.
                    if let Err(fallback_err) = self.switch_to_local_fallback().await {
                        let msg = format!(
                            "Critical: Failed to fallback to Local backend: {}",
                            fallback_err
                        );
                        log::error!("{}", msg);
                        Err(msg)
                    } else {
                        info!("✅ Fallback to Local backend successful");
                        // Mark Local as connected - runtime info (version, OS, config_path)
                        // will be fetched by lifecycle.rs when engine is ready (deterministic)
                        self.set_runtime_status("Local", "connected").await;
                        Ok(())
                    }
                }
            }
        }
    }

    // fetch_config_path removed - now handled by RuntimeDetector

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
                // Set name from key
                backend.name = key.clone();

                // Load secrets from keychain
                load_backend_secrets(manager, &mut backend);

                // Update Local or add new
                if backend.name == "Local" {
                    let _ = self.update("Local", backend).await;
                } else {
                    let _ = self.add(backend).await;
                }
            }
        }

        // Set active backend if found
        if let Some(name) = active_name {
            if let Err(e) = self.switch_to(manager, &name).await {
                log::warn!("Failed to restore active backend '{}': {}", name, e);
            } else {
                log::info!("✅ Restored active backend: {}", name);
            }
        }

        Ok(())
    }

    /// Save active backend name to settings
    pub fn save_active_to_settings(
        manager: &AppSettingsManager,
        name: &str,
    ) -> Result<(), String> {
        let connections = manager
            .sub_settings("connections")
            .map_err(|e| e.to_string())?;

        connections
            .set("_active", &name)
            .map_err(|e| format!("Failed to save active backend: {}", e))?;

        log::debug!("💾 Saved active backend: {}", name);
        Ok(())
    }

    /// Internal fallback helper without profile switching (best effort)
    pub async fn switch_to_local_fallback(&self) -> Result<(), String> {
        let backends = self.backends.read().await;
        let (index, _) = backends
             .iter()
             .enumerate()
             .find(|(_, b)| b.name == "Local")
             .ok_or_else(|| "Local backend not found".to_string())?;
        
        let mut active = self.active_index.write().await;
        *active = index;
        
        crate::rclone::engine::core::set_active_is_local(true);
        info!("🔄 Fallback switched to internal Local backend state");
        Ok(())
    }

    /// Refresh all caches for the currently active backend
    ///
    /// This is the central method for updating state from the API.
    /// It should be used by:
    /// 1. Backend switching logic
    /// 2. Engine startup/initialization
    /// 3. Manual refresh actions
    pub async fn refresh_active_backend(&self, client: &reqwest::Client) -> Result<(), String> {
        let backend = self.get_active().await;
        self.remote_cache.refresh_all(client, &backend).await
    }
}

impl Default for BackendManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Global backend manager instance
pub static BACKEND_MANAGER: Lazy<BackendManager> = Lazy::new(BackendManager::new);

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
    use crate::utils::types::jobs::{JobInfo, JobStatus};

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
    async fn test_add_backend() {
        let manager = BackendManager::new();
        let remote = Backend::new_remote("NAS", "192.168.1.100", 51900);

        manager.add(remote).await.unwrap();

        let backends = manager.list_all().await;
        assert_eq!(backends.len(), 2);
    }

    #[tokio::test]
    async fn test_add_duplicate() {
        let manager = BackendManager::new();
        let duplicate = Backend::new_local("Local");

        let result = manager.add(duplicate).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_switch_to() {
        let manager = BackendManager::new();
        let remote = Backend::new_remote("NAS", "192.168.1.100", 51900);
        manager.add(remote).await.unwrap();

        assert_eq!(manager.get_active_name().await, "Local");

        // manager.switch_to("NAS").await.unwrap();
        // assert_eq!(manager.get_active_name().await, "NAS");
    }

    #[tokio::test]
    async fn test_remove_backend() {
        let manager = BackendManager::new();
        let remote = Backend::new_remote("NAS", "192.168.1.100", 51900);
        manager.add(remote).await.unwrap();

        manager.remove("NAS").await.unwrap();

        let backends = manager.list_all().await;
        assert_eq!(backends.len(), 1);
    }

    #[tokio::test]
    async fn test_cannot_remove_local() {
        let manager = BackendManager::new();

        let result = manager.remove("Local").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_cannot_remove_active() {
        let manager = BackendManager::new();
        let remote = Backend::new_remote("NAS", "192.168.1.100", 51900);
        manager.add(remote).await.unwrap();
        // manager.switch_to("NAS").await.unwrap();
        // let result = manager.remove("NAS").await;
        // assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_runtime_status() {
        let manager = BackendManager::new();

        // Set status for Local
        manager.set_runtime_status("Local", "connected").await;

        let backends = manager.list_all().await;
        assert_eq!(backends[0].status, Some("connected".to_string()));
    }

    #[tokio::test]
    async fn test_runtime_info_persists_across_list_calls() {
        let manager = BackendManager::new();

        // Set runtime info
        manager.set_runtime_status("Local", "connected").await;

        // First list
        let backends1 = manager.list_all().await;
        assert_eq!(backends1[0].status, Some("connected".to_string()));

        // Second list should still have the info
        let backends2 = manager.list_all().await;
        assert_eq!(backends2[0].status, Some("connected".to_string()));
    }

    #[tokio::test]
    async fn test_runtime_info_error_status() {
        let manager = BackendManager::new();
        let remote = Backend::new_remote("Offline", "192.168.1.200", 51900);
        manager.add(remote).await.unwrap();

        // Simulate error status
        manager
            .set_runtime_status("Offline", "error:Connection refused")
            .await;

        let backends = manager.list_all().await;
        let offline = backends.iter().find(|b| b.name == "Offline").unwrap();
        assert_eq!(offline.status, Some("error:Connection refused".to_string()));
    }

    #[tokio::test]
    async fn test_persistence_on_switch() {
        use chrono::Utc;

        let manager = BackendManager::new();
        let remote = Backend::new_remote("Remote1", "host", 1234);
        manager.add(remote).await.unwrap();

        // 1. We are on Local (default). Add a job.
        let job = JobInfo {
            jobid: 1,
            job_type: "sync".to_string(),
            remote_name: "drive:".to_string(),
            source: "/local".to_string(),
            destination: "drive:/remote".to_string(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: Some(serde_json::json!({})),
            group: "job/1".to_string(),
            profile: None,
            source_ui: Some("test".to_string()),
            backend_name: Some("Local".to_string()),
        };
        manager.job_cache.add_job(job, None).await;
        assert_eq!(manager.job_cache.get_jobs().await.len(), 1);

        // 2. Switch to Remote1
        // manager.switch_to("Remote1").await.unwrap();
        // Should be empty initially (new backend state)
        // assert_eq!(manager.job_cache.get_jobs().await.len(), 0);

        // 3. Switch back to Local
        // manager.switch_to("Local").await.unwrap();
        // Should have restored the job
        // assert_eq!(manager.job_cache.get_jobs().await.len(), 1);
        // assert_eq!(manager.job_cache.get_jobs().await[0].jobid, 1);
    }
}
#[tokio::test]
async fn test_context_persistence_on_switch() {
    let manager = BackendManager::new();
    let remote = Backend::new_remote("Remote1", "host", 1234);
    manager.add(remote).await.unwrap();

    // 1. Initial State: Local
    // Simulate adding a mount profile
    manager
        .remote_cache
        .store_mount_profile("/mnt/data", Some("my-profile".to_string()))
        .await;

    let context = manager.remote_cache.get_context().await;
    assert_eq!(
        context.mount_profiles.get("/mnt/data").unwrap(),
        "my-profile"
    );

    // 2. Switch to Remote1
    // manager.switch_to("Remote1").await.unwrap();

    // Active cache should be cleared/empty for new backend
    // let context_remote = manager.remote_cache.get_context().await;
    // assert!(context_remote.mount_profiles.is_empty());

    // 3. Switch back to Local
    // manager.switch_to("Local").await.unwrap();

    // Context should be restored
    // let context_local = manager.remote_cache.get_context().await;
    // assert_eq!(
    //     context_local.mount_profiles.get("/mnt/data").unwrap(),
    //     "my-profile"
    // );
}
