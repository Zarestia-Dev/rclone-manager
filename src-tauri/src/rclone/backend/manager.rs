// Backend Manager - Simplified single-active-backend architecture
//
// Stores multiple backends, but only one is active at runtime.

use log::info;
use once_cell::sync::Lazy;
use rcman::JsonSettingsManager;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{Backend, BackendInfo};
use crate::utils::rclone::endpoints::{EndpointHelper, core};
use crate::utils::types::all_types::{JobCache, RemoteCache};

/// Runtime connectivity info (not persisted)
#[derive(Debug, Clone, Default)]
pub struct RuntimeInfo {
    pub version: Option<String>,
    pub os: Option<String>,
    pub status: Option<String>,
}

/// Per-backend cached state (jobs, mounts, serves)
#[derive(Debug, Clone, Default)]
pub struct BackendState {
    pub jobs: Vec<crate::utils::types::all_types::JobInfo>,
    pub mounts: Vec<crate::utils::types::MountedRemote>,
    pub serves: Vec<crate::utils::types::ServeInstance>,
    pub mount_profiles: HashMap<String, String>,
    pub serve_profiles: HashMap<String, String>,
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
                        runtime.version.clone(),
                        runtime.os.clone(),
                        runtime.status.clone(),
                    )
                } else {
                    info
                }
            })
            .collect()
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
            return Err("Cannot remove the Local backend".to_string());
        }

        let mut backends = self.backends.write().await;
        let active_index = *self.active_index.read().await;

        let index = backends
            .iter()
            .position(|b| b.name == name)
            .ok_or_else(|| format!("Backend '{}' not found", name))?;

        // Can't remove active backend
        if index == active_index {
            return Err("Cannot remove the active backend".to_string());
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
    pub async fn switch_to(&self, name: &str) -> Result<(), String> {
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

        // Don't save/restore if switching to the same backend
        if current_name != name {
            // Save current backend's state
            let jobs = self.job_cache.get_all_jobs().await;
            let (mounts, serves, mount_profiles, serve_profiles) =
                self.remote_cache.get_backend_state().await;

            let current_state = BackendState {
                jobs,
                mounts,
                serves,
                mount_profiles,
                serve_profiles,
            };

            {
                let mut states = self.per_backend_state.write().await;
                states.insert(current_name.clone(), current_state);
                info!("💾 Saved state for backend: {}", current_name);
            }

            // Restore new backend's state (or empty if none exists)
            let new_state = {
                let states = self.per_backend_state.read().await;
                states.get(name).cloned().unwrap_or_default()
            };

            // Restore jobs
            self.job_cache.set_all_jobs(new_state.jobs).await;

            // Restore mounts/serves (remotes will be refreshed from API)
            self.remote_cache
                .set_backend_state(
                    new_state.mounts,
                    new_state.serves,
                    new_state.mount_profiles,
                    new_state.serve_profiles,
                )
                .await;

            // Clear remotes/configs (will be refreshed from new backend)
            self.remote_cache.clear_remotes_only().await;

            info!("📂 Restored state for backend: {}", name);
        }

        // Update active index
        let mut active = self.active_index.write().await;
        *active = new_index;

        // Update cached is_local flag for engine
        crate::rclone::engine::core::set_active_is_local(is_local);

        info!("🔄 Switched to backend: {} (is_local: {})", name, is_local);

        Ok(())
    }

    /// Get OAuth URL of active backend
    /// - For Local: Returns http://{host}:{oauth_port}
    /// - For Remote: Returns main API URL
    pub async fn get_active_oauth_url(&self) -> Option<String> {
        let backend = self.get_active().await;
        if backend.is_local {
            backend
                .oauth_port
                .map(|port| format!("http://{}:{}", backend.host, port))
        } else {
            Some(backend.api_url())
        }
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

        let url = EndpointHelper::build_url(&backend.api_url(), core::VERSION);

        let response = backend
            .inject_auth(client.post(&url))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, body));
        }

        let body = response.text().await.map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();

        let version = json
            .get("version")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_default();
        let os = json
            .get("os")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_default();

        // Update runtime cache (not persisted)
        {
            let mut cache = self.runtime_info.write().await;
            cache.insert(
                name.to_string(),
                RuntimeInfo {
                    version: Some(version.clone()),
                    os: Some(os.clone()),
                    status: Some("connected".to_string()),
                },
            );
        }

        Ok((version, os))
    }

    /// Update runtime status for a backend (used for error states)
    pub async fn set_runtime_status(&self, name: &str, status: &str) {
        let mut cache = self.runtime_info.write().await;
        cache.entry(name.to_string()).or_default().status = Some(status.to_string());
    }

    /// Load backends from settings
    pub async fn load_from_settings(&self, manager: &JsonSettingsManager) -> Result<(), String> {
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
            if let Err(e) = self.switch_to(&name).await {
                log::warn!("Failed to restore active backend '{}': {}", name, e);
            } else {
                log::info!("✅ Restored active backend: {}", name);
            }
        }

        Ok(())
    }

    /// Save active backend name to settings
    pub fn save_active_to_settings(
        manager: &JsonSettingsManager,
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
fn load_backend_secrets(manager: &JsonSettingsManager, backend: &mut Backend) {
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
fn load_backend_secrets(_manager: &JsonSettingsManager, _backend: &mut Backend) {
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

        manager.switch_to("NAS").await.unwrap();
        assert_eq!(manager.get_active_name().await, "NAS");
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
        manager.switch_to("NAS").await.unwrap();

        let result = manager.remove("NAS").await;
        assert!(result.is_err());
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
        use crate::utils::types::all_types::{JobInfo, JobStatus};
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
        manager.switch_to("Remote1").await.unwrap();
        // Should be empty initially (new backend state)
        assert_eq!(manager.job_cache.get_jobs().await.len(), 0);

        // 3. Switch back to Local
        manager.switch_to("Local").await.unwrap();
        // Should have restored the job
        assert_eq!(manager.job_cache.get_jobs().await.len(), 1);
        assert_eq!(manager.job_cache.get_jobs().await[0].jobid, 1);
    }
}
