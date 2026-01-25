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
    types::{Backend, BackendInfo},
};

use crate::utils::types::{
    jobs::{JobCache, JobInfo},
    remotes::RemoteCache,
    scheduled_task::ScheduledTask,
};

use crate::rclone::state::cache::RemoteCacheContext;

// RuntimeInfo is now imported from the runtime module

/// Per-backend cached state (jobs, remote context, scheduled tasks)
#[derive(Debug, Clone, Default)]
pub struct BackendState {
    pub jobs: Vec<JobInfo>,
    pub context: RemoteCacheContext,
    /// Scheduled tasks for this backend (task_id → task)
    pub tasks: HashMap<String, ScheduledTask>,
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

    /// Add a new backend and create its profiles
    ///
    /// Optionally copy from existing backend profiles
    pub async fn add(
        &self,
        manager: &AppSettingsManager,
        backend: Backend,
        copy_backend_from: Option<&str>,
        copy_remotes_from: Option<&str>,
    ) -> Result<(), String> {
        let mut backends = self.backends.write().await;

        // Check for duplicate name
        if backends.iter().any(|b| b.name == backend.name) {
            return Err(format!("Backend '{}' already exists", backend.name));
        }

        info!("➕ Adding backend: {}", backend.name);

        // Helper closure to create or duplicate a profile
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

        // Skip state swap if switching to same backend, BUT ensure proper profile activation
        if current_name != name {
            // Unschedule old backend's tasks
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

            self.save_backend_state(&current_name, task_cache).await;

            // Clear cache to prevent stale data leaking
            self.remote_cache.clear_all().await;

            self.restore_backend_state(name, task_cache).await;

            // LAZY LOADING: Load secrets on-demand if not already loaded
            // This handles backends that were skipped during startup
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

        // Switch profiles for both settings types
        // "Local" backend maps to "default" profile
        let profile_name = if name == "Local" { "default" } else { name };
        info!("👤 Switching profiles to: {}", profile_name);

        self.switch_sub_settings_profile(manager, "remotes", profile_name)
            .await?;
        self.switch_sub_settings_profile(manager, "backend", profile_name)
            .await?;

        // Update active index
        let mut active = self.active_index.write().await;
        *active = new_index;

        // Update cached is_local flag for engine
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

    /// Helper to save current state (Jobs + Context + Tasks)
    async fn save_backend_state(
        &self,
        name: &str,
        task_cache: Option<&crate::rclone::state::scheduled_tasks::ScheduledTasksCache>,
    ) {
        let jobs = self.job_cache.get_all_jobs().await;
        let context = self.remote_cache.get_context().await;

        // Get tasks for this backend
        let tasks = if let Some(cache) = task_cache {
            cache
                .get_tasks_for_backend(name)
                .await
                .into_iter()
                .map(|task| (task.id.clone(), task))
                .collect()
        } else {
            HashMap::new()
        };

        let task_count = tasks.len(); // Capture length before move
        let current_state = BackendState {
            jobs,
            context,
            tasks,
        };

        let mut states = self.per_backend_state.write().await;
        states.insert(name.to_string(), current_state);
        info!(
            "💾 Saved state for backend: {} ({} tasks)",
            name, task_count
        );
    }

    /// Helper to restore stored state for a backend
    async fn restore_backend_state(
        &self,
        name: &str,
        task_cache: Option<&crate::rclone::state::scheduled_tasks::ScheduledTasksCache>,
    ) {
        let new_state = {
            let states = self.per_backend_state.read().await;
            states.get(name).cloned().unwrap_or_default()
        };

        self.job_cache.set_all_jobs(new_state.jobs).await;
        self.remote_cache.set_context(new_state.context).await;

        // Restore tasks for this backend
        if let Some(cache) = task_cache {
            cache
                .replace_tasks_for_backend(name, new_state.tasks.clone())
                .await;
        }

        info!(
            "📂 Restored state for backend: {} ({} tasks)",
            name,
            new_state.tasks.len()
        );
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

                // LAZY LOADING: Only load secrets for active backend + Local on startup
                // Others will be loaded on-demand when switched to
                let should_load_secrets = backend.name == "Local"
                    || active_name
                        .as_ref()
                        .map(|n| n == &backend.name)
                        .unwrap_or(false);

                if should_load_secrets {
                    load_backend_secrets(manager, &mut backend);
                    log::debug!("🔐 Loaded secrets for backend: {}", backend.name);
                } else {
                    log::debug!("⏭️ Deferred secret loading for backend: {}", backend.name);
                }

                // Update Local or add new
                if backend.name == "Local" {
                    let _ = self.update(manager, "Local", backend).await;
                } else {
                    let _ = self.add(manager, backend, None, None).await;
                }
            }
        }

        // Set active backend if found
        if let Some(name) = active_name {
            if let Err(e) = self.switch_to(manager, &name, None, None).await {
                log::warn!("Failed to restore active backend '{}': {}", name, e);
            } else {
                log::info!("✅ Restored active backend: {}", name);
            }
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

    /// Check non-active backends in background
    pub async fn check_other_backends(&self, client: &reqwest::Client) {
        let backends = self.list_all().await;
        let active_name = self.get_active_name().await;

        for backend in backends {
            if backend.name == active_name || backend.name == "Local" {
                continue; // Already checked
            }

            info!("🔍 Background check for backend: {}", backend.name);
            if let Err(e) = self.check_connectivity(&backend.name, client).await {
                log::warn!("⚠️ Backend '{}' unreachable: {}", backend.name, e);
                self.set_runtime_status(&backend.name, &format!("error:{}", e))
                    .await;
            } else {
                info!("✅ Backend '{}' is reachable", backend.name);
            }
        }
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
