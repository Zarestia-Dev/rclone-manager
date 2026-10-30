use std::collections::HashMap;
use std::sync::Arc;

use log::info;
use parking_lot::RwLock as SyncRwLock;
use tokio::sync::RwLock;

use crate::services::settings::AppSettingsManager;
use crate::utils::constants::{
    ENGINE_SUB_SETTINGS, LOCAL_BACKEND_NAME, SUB_BACKEND, SUB_QUICK_RUNS, SUB_REMOTES,
    SUB_WORKFLOWS,
};
use crate::utils::types::{jobs::JobCache, remotes::RemoteCache};

use super::{
    runtime::RuntimeInfo,
    types::{Backend, BackendInfo},
};

/// Live caches stay with their owner; backend selection shares immutable options snapshots.
#[derive(Debug, Default)]
struct BackendState {
    jobs: Arc<JobCache>,
    remotes: Arc<RemoteCache>,
    options: Option<Arc<crate::rclone::state::options::OptionsCacheEntry>>,
}

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
            backends: vec![Backend::new_local(LOCAL_BACKEND_NAME)],
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

/// Existing backends whose settings a new backend's profiles are copied from.
/// A missing source starts that group empty.
#[derive(Debug, Default, Clone, Copy)]
pub struct CopySources<'a> {
    pub backend: Option<&'a str>,
    pub remotes: Option<&'a str>,
    /// Quick Runs and Workflows.
    pub flow: Option<&'a str>,
}

/// Central manager for rclone backends
pub struct BackendManager {
    /// Combined lock for backends list + active index.
    /// Never split these into two locks — see `BackendsState` docs.
    state: RwLock<BackendsState>,
    /// Serialize user-triggered switches through cache and scheduler reconciliation.
    pub(crate) switch_lock: tokio::sync::Mutex<()>,
    /// Runtime connectivity info (version, os, status) - not persisted
    runtime_info: RwLock<HashMap<String, RuntimeInfo>>,
    /// Per-backend state storage (`backend_name` → cached state)
    per_backend_state: SyncRwLock<HashMap<String, BackendState>>,
    /// Shared options cache (for active backend)
    pub options_cache: Arc<crate::rclone::state::options::OptionsCache>,
}

impl BackendManager {
    /// Create a new manager with just the Local backend
    pub fn new() -> Self {
        Self {
            state: RwLock::new(BackendsState::new()),
            switch_lock: tokio::sync::Mutex::new(()),
            runtime_info: RwLock::new(HashMap::new()),
            per_backend_state: SyncRwLock::new(HashMap::new()),
            options_cache: Arc::new(crate::rclone::state::options::OptionsCache::new()),
        }
    }

    /// Get a clone of the active backend
    pub async fn get_active(&self) -> Backend {
        self.state.read().await.active().clone()
    }

    /// Capture a backend snapshot while rejecting requests from a stale selection.
    pub async fn get_active_checked(&self, expected: Option<&str>) -> Result<Backend, String> {
        let state = self.state.read().await;
        if expected.is_some_and(|name| name != state.active_name()) {
            return Err(
                crate::localized_error!("backendErrors.request.failed", "error" => "Backend selection changed"),
            );
        }
        Ok(state.active().clone())
    }

    /// Get the name of the active backend
    pub async fn get_active_name(&self) -> String {
        self.state.read().await.active_name().to_string()
    }

    /// Read a remote's settings while backend selection is held stable.
    pub async fn active_remote_settings(
        &self,
        manager: &AppSettingsManager,
        remote_name: &str,
        expected_backend: Option<&str>,
    ) -> Result<(Backend, crate::utils::types::remotes::RemoteSettings), String> {
        let state = self.state.read().await;
        if let Some(expected) = expected_backend
            && expected != state.active_name()
        {
            return Err(crate::localized_error!(
                "backendErrors.request.failed",
                "error" => format!("Backend selection changed from '{expected}' to '{}'", state.active_name())
            ));
        }
        let settings = crate::utils::types::remotes::RemoteSettings::load(manager, remote_name)?;
        Ok((state.active().clone(), settings))
    }

    /// Capture the scheduler's remote settings and their backend in one read.
    pub async fn active_remote_configs(
        &self,
        manager: &AppSettingsManager,
    ) -> (
        Backend,
        HashMap<String, crate::utils::types::remotes::RemoteSettings>,
    ) {
        let state = self.state.read().await;
        let settings = crate::utils::types::remotes::RemoteSettings::load_all(manager);
        (state.active().clone(), settings)
    }

    /// Capture the selected backend's cache. Existing users retain this cache
    /// across backend switches, including monitors for jobs still in flight.
    pub async fn job_cache(&self) -> Arc<JobCache> {
        self.job_cache_for(&self.get_active_name().await)
    }

    pub fn job_cache_for(&self, backend_name: &str) -> Arc<JobCache> {
        if let Some(state) = self.per_backend_state.read().get(backend_name) {
            return state.jobs.clone();
        }
        self.per_backend_state
            .write()
            .entry(backend_name.to_string())
            .or_default()
            .jobs
            .clone()
    }

    pub async fn remote_cache(&self) -> Arc<RemoteCache> {
        self.remote_cache_for(&self.get_active_name().await)
    }

    pub fn remote_cache_for(&self, backend_name: &str) -> Arc<RemoteCache> {
        if let Some(state) = self.per_backend_state.read().get(backend_name) {
            return state.remotes.clone();
        }
        self.per_backend_state
            .write()
            .entry(backend_name.to_string())
            .or_default()
            .remotes
            .clone()
    }

    /// Counts running jobs, mounts and serves across all cached backends.
    pub async fn active_operation_counts(&self) -> (usize, usize, usize) {
        let caches: Vec<_> = self
            .per_backend_state
            .read()
            .values()
            .map(|state| (state.jobs.clone(), state.remotes.clone()))
            .collect();
        let mut counts = (0, 0, 0);
        for (jobs, remotes) in caches {
            let (jobs, mounts, serves) = tokio::join!(
                jobs.get_active_jobs(),
                remotes.get_mounted_remotes(),
                remotes.get_serves(),
            );
            counts.0 += jobs.len();
            counts.1 += mounts.len();
            counts.2 += serves.len();
        }
        counts
    }

    /// Check if the active backend is a local backend
    pub async fn is_active_local(&self) -> bool {
        self.state.read().await.active().is_local
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
        let (backends, active_index) = {
            let state = self.state.read().await;
            (state.backends.clone(), state.active_index)
        };

        let runtime_cache = self.runtime_info.read().await;

        backends
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let mut info = BackendInfo::from_backend(b, i == active_index);
                if let Some(runtime) = runtime_cache.get(&b.name) {
                    info = info.with_runtime_info(
                        runtime.version.clone(),
                        runtime.os.clone(),
                        Some(runtime.status.clone()),
                        runtime.config_path.clone(),
                    );
                }
                info
            })
            .collect()
    }

    /// Helper to get the config path of the Local backend
    #[cfg(not(feature = "librclone"))]
    pub async fn get_local_config_path(&self) -> Result<Option<std::path::PathBuf>, String> {
        self.state
            .read()
            .await
            .backends
            .iter()
            .find(|b| b.name == LOCAL_BACKEND_NAME)
            .map(|b| b.config_path.clone())
            .ok_or_else(
                || crate::localized_error!("backendErrors.backend.notFound", "name" => LOCAL_BACKEND_NAME),
            )
    }

    /// Add a new backend and initialize its settings profiles
    ///
    /// # Arguments
    /// * `manager` - App settings manager to create profiles
    /// * `backend` - Backend connection details
    /// * `copy` - Backends whose settings the new profiles start from
    pub async fn add(
        &self,
        manager: &AppSettingsManager,
        backend: Backend,
        copy: CopySources<'_>,
    ) -> Result<(), String> {
        let mut state = self.state.write().await;

        // Names are also profile directory names, which differ only by case on
        // Windows and macOS. Local's profile is `default`, so that name is taken too.
        let profile = Backend::profile_name_for(&backend.name);
        let fold = |name: &str| {
            name.chars()
                .flat_map(char::to_lowercase)
                .collect::<Vec<_>>()
        };
        let folded = fold(profile);
        if state
            .backends
            .iter()
            .any(|b| fold(Backend::profile_name_for(&b.name)) == folded)
        {
            return Err(crate::localized_error!(
                "backendErrors.backend.alreadyExists",
                "name" => &backend.name
            ));
        }

        info!("Adding backend: {}", backend.name);

        let setup_profile = |sub_name: &str, source: Option<&str>| {
            if let Ok(sub) = manager.sub_settings(sub_name)
                && let Ok(pm) = sub.profiles()
            {
                match source {
                    Some(src) => {
                        // The backend is new, so data under its name was left by a restore
                        // or an interrupted removal. An explicit copy replaces it.
                        if pm.exists(&backend.name).unwrap_or(false) {
                            log::warn!(
                                "Replacing existing {sub_name} profile '{}' with a copy of '{src}'",
                                backend.name
                            );
                            if let Err(e) = pm.delete(&backend.name) {
                                log::warn!("Failed to remove stale {sub_name} profile: {e}");
                            }
                        }
                        let src_profile = Backend::profile_name_for(src);
                        pm.duplicate(src_profile, &backend.name)
                            .map(|()| {
                                info!("Copied {} from '{}' to '{}'", sub_name, src, backend.name);
                            })
                            .or_else(|e| {
                                log::warn!("Failed to duplicate {sub_name} profile: {e}");
                                pm.create(&backend.name)
                            })
                    }
                    // Saved backends are added again on every start and after a restore,
                    // so an existing profile is the backend's own data.
                    None => pm.create(&backend.name),
                }
                .ok();
            }
        };

        setup_profile(SUB_BACKEND, copy.backend);
        setup_profile(SUB_REMOTES, copy.remotes);
        // Workflows reference Quick Runs by id, so both start from the same source.
        setup_profile(SUB_QUICK_RUNS, copy.flow);
        setup_profile(SUB_WORKFLOWS, copy.flow);

        state.backends.push(backend);
        Ok(())
    }

    /// Update an existing backend's connection details
    pub async fn update(&self, name: &str, backend: Backend) -> Result<(), String> {
        let mut state = self.state.write().await;

        let index = state
            .backends
            .iter()
            .position(|b| b.name == name)
            .ok_or_else(
                || crate::localized_error!("backendErrors.backend.notFound", "name" => name),
            )?;

        info!("Updating backend: {name}");
        state.backends[index] = backend;
        Ok(())
    }

    /// Drops a backend from memory and keeps its settings profiles.
    async fn detach(&self, name: &str) -> Result<(), String> {
        if Backend::is_local_name(name) {
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

        state.backends.remove(index);

        if state.active_index > index {
            state.active_index -= 1;
        }

        drop(state);

        self.per_backend_state.write().remove(name);
        self.runtime_info.write().await.remove(name);
        Ok(())
    }

    /// Remove a backend by name and delete its associated profiles
    pub async fn remove(&self, manager: &AppSettingsManager, name: &str) -> Result<(), String> {
        self.detach(name).await?;

        for sub_name in ENGINE_SUB_SETTINGS {
            if let Ok(sub) = manager.sub_settings(sub_name)
                && let Ok(pm) = sub.profiles()
                && let Err(e) = pm.delete(name)
            {
                log::warn!("Failed to delete '{sub_name}' profile for {name}: {e}");
            }
        }

        Ok(())
    }

    /// Switch to a different backend and manage its state and profiles
    ///
    /// Settings profiles and selected backend change under the same lock.
    /// Jobs remain in their owning caches throughout the switch.
    ///
    /// Task unscheduling/rescheduling is the caller's responsibility.
    pub async fn switch_to(&self, manager: &AppSettingsManager, name: &str) -> Result<(), String> {
        let mut state = self.state.write().await;
        let new_index = state.find_index(name).ok_or_else(
            || crate::localized_error!("backendErrors.backend.notFound", "name" => name),
        )?;
        let is_local = state.backends[new_index].is_local;
        let current_name = state.active_name().to_string();
        let profile_name = Backend::profile_name_for(name);
        info!("Switching profiles to: {profile_name}");

        for (switched, sub_name) in ENGINE_SUB_SETTINGS.iter().enumerate() {
            if let Err(error) = self.switch_sub_settings_profile(manager, sub_name, profile_name) {
                for restored in &ENGINE_SUB_SETTINGS[..switched] {
                    if let Err(rollback_error) = self.switch_sub_settings_profile(
                        manager,
                        restored,
                        Backend::profile_name_for(&current_name),
                    ) {
                        log::error!(
                            "Failed to restore {restored} settings after backend switch: {rollback_error}"
                        );
                    }
                }
                return Err(error);
            }
        }

        if current_name != name {
            self.save_options(&current_name).await;
            self.restore_options(name).await;
        }
        state.active_index = new_index;

        info!("Switched to backend: {name} (is_local: {is_local})");
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
            if let Ok(pm) = sub.profiles()
                && !pm.exists(profile_name).unwrap_or(false)
                && let Err(e) = pm.create(profile_name)
            {
                log::warn!("Failed to ensure profile '{profile_name}' for {sub_name}: {e}");
            }

            if let Err(e) = sub.switch_profile(profile_name) {
                log::error!("Failed to switch {sub_name} to profile '{profile_name}': {e}");
                return Err(format!("Failed to switch {sub_name} profile: {e}"));
            }
            log::info!("Switched '{sub_name}' to profile: {profile_name}");
            Ok(())
        } else {
            log::error!("Failed to access '{sub_name}' sub-settings");
            Err(format!("Failed to access '{sub_name}' sub-settings"))
        }
    }

    /// Set runtime info for a backend (used by connectivity module)
    pub(crate) async fn set_runtime_info(&self, name: &str, info: RuntimeInfo) {
        log::debug!("Backend '{name}' runtime: os={:?}", info.os);
        self.runtime_info
            .write()
            .await
            .insert(name.to_string(), info);
    }

    /// Forget what was detected for a backend, e.g. after its address changed.
    pub(crate) async fn clear_runtime_info(&self, name: &str) {
        self.runtime_info.write().await.remove(name);
    }

    /// Get runtime info for a specific backend
    pub(crate) async fn get_runtime_info(&self, name: &str) -> Option<RuntimeInfo> {
        self.runtime_info.read().await.get(name).cloned()
    }

    async fn save_options(&self, name: &str) {
        let options = self.options_cache.get_entry().await;
        self.per_backend_state
            .write()
            .entry(name.to_string())
            .or_default()
            .options = options;
    }

    async fn restore_options(&self, name: &str) {
        let options = self
            .per_backend_state
            .read()
            .get(name)
            .and_then(|state| state.options.clone());
        self.options_cache.set_entry(options).await;
    }

    /// Get the runtime OS for a specific backend
    pub(crate) async fn get_runtime_os(&self, name: &str) -> Option<String> {
        self.runtime_info
            .read()
            .await
            .get(name)
            .and_then(|info| info.os.clone())
    }

    /// Update runtime status for a backend (used for error states)
    pub(crate) async fn set_runtime_status(
        &self,
        name: &str,
        status: crate::rclone::backend::runtime::RuntimeStatus,
    ) {
        self.runtime_info
            .write()
            .await
            .entry(name.to_string())
            .or_default()
            .status = status;
    }

    /// Load backends from settings
    pub async fn load_from_settings(&self, manager: &AppSettingsManager) -> Result<(), String> {
        let connections = manager
            .sub_settings("connections")
            .map_err(|e| e.to_string())?;

        let keys = connections.list().map_err(|e| e.to_string())?;

        let mut active_name: Option<String> = None;
        let mut saved_names = std::collections::HashSet::new();

        for key in keys {
            if key == "_active" {
                if let Ok(value) = connections.get_value(&key) {
                    active_name = value.as_str().map(String::from);
                }
                continue;
            }

            saved_names.insert(key.clone());

            if let Ok(value) = connections.get_value(&key)
                && let Ok(mut backend) = serde_json::from_value::<Backend>(value)
            {
                backend.name = key.clone();

                if Backend::is_local_name(&backend.name) {
                    // Generated RC credentials are never saved, but the running
                    // engine still requires them after a reload or restore.
                    if !backend.has_valid_auth()
                        && let Some(running) = self.get(LOCAL_BACKEND_NAME).await
                        && running.is_auth_generated
                    {
                        backend.username = running.username;
                        backend.password = running.password;
                        backend.is_auth_generated = true;
                    }
                    let _ = self.update(LOCAL_BACKEND_NAME, backend).await;
                } else if let Some(loaded) = self.get(&key).await {
                    // A reload or restore can carry a new address or credentials.
                    if loaded.host != backend.host
                        || loaded.port != backend.port
                        || loaded.username != backend.username
                        || loaded.password != backend.password
                    {
                        self.clear_runtime_info(&key).await;
                    }
                    let _ = self.update(&key, backend).await;
                } else if let Err(error) = self.add(manager, backend, CopySources::default()).await
                {
                    log::warn!("Skipping saved backend '{key}': {error}");
                }
            }
        }

        let target_backend = active_name.unwrap_or_else(|| {
            log::info!("No active backend saved, defaulting to Local");
            LOCAL_BACKEND_NAME.to_string()
        });

        if let Err(e) = self.switch_to(manager, &target_backend).await {
            log::warn!(
                "Failed to restore active backend '{target_backend}': {e}. Reverting to Local."
            );
            if !Backend::is_local_name(&target_backend)
                && let Err(revert_e) = self.switch_to(manager, LOCAL_BACKEND_NAME).await
            {
                log::error!("Critical: Failed to revert to Local backend: {revert_e}");
            }
        } else {
            log::info!("Restored active backend: {target_backend}");
        }

        // A restore can leave out backends that were loaded before it. Their profiles stay
        // on disk; only the live entry goes, so nothing is lost if the file was incomplete.
        let active_name = self.get_active_name().await;
        let stale: Vec<String> = self
            .state
            .read()
            .await
            .backends
            .iter()
            .map(|b| b.name.clone())
            .filter(|name| {
                !Backend::is_local_name(name) && *name != active_name && !saved_names.contains(name)
            })
            .collect();
        for name in stale {
            if let Err(error) = self.detach(&name).await {
                log::warn!("Failed to drop backend '{name}' missing from saved settings: {error}");
            }
        }

        Ok(())
    }
}

impl Default for BackendManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Persist the active backend name to settings.
///
/// Logs a warning on failure; callers should not treat this as fatal.
pub fn save_active_backend_to_settings(manager: &AppSettingsManager, name: &str) {
    let result = (|| -> Result<(), String> {
        let connections = manager
            .sub_settings("connections")
            .map_err(|e| e.to_string())?;
        connections
            .set("_active", &name)
            .map_err(|e| format!("Failed to save active backend: {e}"))
    })();

    match result {
        Ok(()) => log::debug!("Saved active backend: {name}"),
        Err(e) => log::warn!("Failed to persist active backend '{name}': {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_save_and_restore_empty_state() {
        let manager = BackendManager::new();
        // Saving then restoring with no data should not panic
        manager.save_options(LOCAL_BACKEND_NAME).await;
        manager.restore_options(LOCAL_BACKEND_NAME).await;
    }

    #[tokio::test]
    async fn runtime_status_updates_initialize_missing_entries_and_preserve_existing_metadata() {
        use super::super::runtime::RuntimeStatus;

        let manager = BackendManager::new();
        let name = "NAS & Cloud";
        manager
            .set_runtime_status(name, RuntimeStatus::Error("connection closed".into()))
            .await;
        let initial = manager.get_runtime_info(name).await.unwrap();
        assert_eq!(
            initial.error_message().as_deref(),
            Some("connection closed")
        );
        assert!(initial.version.is_none());
        assert!(initial.os.is_none());
        assert!(manager.get_runtime_info("another backend").await.is_none());

        manager
            .set_runtime_info(
                name,
                RuntimeInfo {
                    version: Some("v1.75.0".into()),
                    os: Some("linux".into()),
                    status: RuntimeStatus::Connected,
                    ..Default::default()
                },
            )
            .await;
        manager
            .set_runtime_status(name, RuntimeStatus::Error("authentication rejected".into()))
            .await;
        let updated = manager.get_runtime_info(name).await.unwrap();
        assert_eq!(
            updated.error_message().as_deref(),
            Some("authentication rejected")
        );
        assert_eq!(updated.version.as_deref(), Some("v1.75.0"));
        assert_eq!(updated.os.as_deref(), Some("linux"));
    }

    #[tokio::test]
    async fn options_restore_preserves_payload_and_expiry_and_clears_absent_backend() {
        let manager = BackendManager::new();
        let payload = serde_json::json!({"providers": {"drive": {"flag": "a'b,c"}}});
        manager.options_cache.set("A".into(), payload.clone()).await;
        let original = manager.options_cache.get_entry().await.unwrap();
        let cached_at = original.cached_at;
        manager.save_options("A").await;
        manager.restore_options("B").await;
        assert!(manager.options_cache.get_entry().await.is_none());
        manager.restore_options("A").await;
        assert_eq!(manager.options_cache.get("A").await, Some(payload));
        assert!(Arc::ptr_eq(
            &original,
            &manager.options_cache.get_entry().await.unwrap()
        ));
        assert_eq!(
            manager.options_cache.get_entry().await.unwrap().cached_at,
            cached_at
        );
    }

    #[tokio::test]
    async fn restoring_an_expired_options_snapshot_does_not_renew_its_ttl() {
        use crate::rclone::state::options::{OPTIONS_CACHE_TTL, OptionsCacheEntry};
        let manager = BackendManager::new();
        let original = Arc::new(OptionsCacheEntry {
            backend_name: "旅行 & Arşiv".into(),
            cached_at: std::time::Instant::now()
                - OPTIONS_CACHE_TTL
                - std::time::Duration::from_secs(1),
            payload: serde_json::json!({"main": [{"Value": 0}]}),
        });
        manager
            .options_cache
            .set_entry(Some(original.clone()))
            .await;
        manager.save_options("旅行 & Arşiv").await;
        manager.restore_options("another backend").await;
        manager.restore_options("旅行 & Arşiv").await;
        let restored = manager.options_cache.get_entry().await.unwrap();
        assert!(Arc::ptr_eq(&original, &restored));
        assert_eq!(restored.cached_at, original.cached_at);
        assert!(manager.options_cache.get("旅行 & Arşiv").await.is_none());
        assert!(manager.options_cache.get("another backend").await.is_none());
    }

    #[tokio::test]
    async fn backend_switch_snapshots_do_not_replace_live_job_caches() {
        use crate::rclone::commands::job::JobMetadata;
        use crate::utils::types::jobs::{JobStatus, JobType};

        let manager = BackendManager::new();
        let a = manager.job_cache_for("A");
        let b = manager.job_cache_for("B");
        let metadata = JobMetadata::new("drive", JobType::Sync, vec!["src".into()], "dst");
        a.create_job(7, metadata.clone(), "A".into()).await;
        b.create_job(7, metadata, "B".into()).await;

        manager.save_options("A").await;
        manager.restore_options("B").await;
        a.complete_job(7, true, None).await.unwrap();
        manager.restore_options("A").await;

        let restored_a = manager.job_cache_for("A");
        assert!(Arc::ptr_eq(&a, &restored_a));
        assert_eq!(
            restored_a.get_job(7).await.unwrap().status,
            JobStatus::Completed
        );
        assert_eq!(b.get_job(7).await.unwrap().status, JobStatus::Running);
        assert!(Arc::ptr_eq(&b, &manager.job_cache_for("B")));
    }

    #[test]
    fn concurrent_cache_access_keeps_one_cache_per_backend() {
        let manager = BackendManager::new();
        let barrier = std::sync::Barrier::new(8);
        let caches = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        (manager.job_cache_for("A"), manager.remote_cache_for("A"))
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        for (jobs, remotes) in &caches {
            assert!(Arc::ptr_eq(jobs, &caches[0].0));
            assert!(Arc::ptr_eq(remotes, &caches[0].1));
        }
        assert!(!Arc::ptr_eq(&caches[0].0, &manager.job_cache_for("B")));
        assert!(!Arc::ptr_eq(&caches[0].1, &manager.remote_cache_for("B")));
    }

    fn settings_with_profiles(include_backend: bool) -> (tempfile::TempDir, AppSettingsManager) {
        let directory = tempfile::tempdir().unwrap();
        let mut builder = rcman::SettingsManager::builder("backend-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("quick_runs").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("workflows").with_profiles());
        if include_backend {
            builder = builder
                .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles());
        }
        (directory, builder.build().unwrap())
    }

    #[tokio::test]
    async fn remote_settings_are_read_from_the_expected_backend() {
        let (_directory, settings) = settings_with_profiles(true);
        let manager = BackendManager::new();
        for name in ["A", "B"] {
            manager
                .add(
                    &settings,
                    Backend::new_remote(name, "127.0.0.1", 0),
                    CopySources::default(),
                )
                .await
                .unwrap();
            manager.switch_to(&settings, name).await.unwrap();
            settings
                .sub_settings("remotes")
                .unwrap()
                .set("drive", &serde_json::json!({ "primaryActions": [name] }))
                .unwrap();
        }

        assert!(
            manager
                .active_remote_settings(&settings, "drive", Some("A"))
                .await
                .is_err()
        );
        let (backend, remote) = manager
            .active_remote_settings(&settings, "drive", None)
            .await
            .unwrap();
        assert_eq!(backend.name, "B");
        assert_eq!(remote.primary_actions.unwrap(), ["B"]);

        manager.switch_to(&settings, "A").await.unwrap();
        let (backend, remote) = manager
            .active_remote_settings(&settings, "drive", Some("A"))
            .await
            .unwrap();
        assert_eq!(backend.name, "A");
        assert_eq!(remote.primary_actions.unwrap(), ["A"]);
        assert!(
            manager
                .active_remote_settings(&settings, "missing", Some("A"))
                .await
                .is_err()
        );
    }

    fn flow_ids(settings: &AppSettingsManager, section: &str) -> Vec<String> {
        let mut ids = settings.sub_settings(section).unwrap().list().unwrap();
        ids.sort();
        ids
    }

    #[tokio::test]
    async fn quick_runs_and_workflows_follow_the_selected_backend() {
        let (_directory, settings) = settings_with_profiles(true);
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Other", "127.0.0.1", 0),
                CopySources::default(),
            )
            .await
            .unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            settings
                .sub_settings(section)
                .unwrap()
                .set("local-item", &serde_json::json!({"name": "local"}))
                .unwrap();
        }

        manager.switch_to(&settings, "Other").await.unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            assert!(flow_ids(&settings, section).is_empty());
            settings
                .sub_settings(section)
                .unwrap()
                .set("other-item", &serde_json::json!({"name": "other"}))
                .unwrap();
        }

        manager
            .switch_to(&settings, LOCAL_BACKEND_NAME)
            .await
            .unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            assert_eq!(flow_ids(&settings, section), ["local-item"]);
        }
    }

    #[tokio::test]
    async fn a_backend_added_before_flow_profiles_existed_gets_an_empty_profile_on_switch() {
        let (_directory, settings) = settings_with_profiles(true);
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Old", "127.0.0.1", 0),
                CopySources::default(),
            )
            .await
            .unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            settings
                .sub_settings(section)
                .unwrap()
                .profiles()
                .unwrap()
                .delete("Old")
                .unwrap();
        }

        manager.switch_to(&settings, "Old").await.unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            assert!(flow_ids(&settings, section).is_empty());
        }
    }

    #[tokio::test]
    async fn copy_sources_start_each_group_from_the_chosen_backend() {
        let (_directory, settings) = settings_with_profiles(true);
        let manager = BackendManager::new();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            settings
                .sub_settings(section)
                .unwrap()
                .set("local-item", &serde_json::json!({"name": "local"}))
                .unwrap();
        }
        settings
            .sub_settings(SUB_REMOTES)
            .unwrap()
            .set("drive", &serde_json::json!({"primaryActions": ["mount"]}))
            .unwrap();

        manager
            .add(
                &settings,
                Backend::new_remote("Copy", "127.0.0.1", 0),
                CopySources {
                    flow: Some(LOCAL_BACKEND_NAME),
                    ..CopySources::default()
                },
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "Copy").await.unwrap();

        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            assert_eq!(flow_ids(&settings, section), ["local-item"]);
        }
        assert!(flow_ids(&settings, SUB_REMOTES).is_empty());
    }

    /// Data a restore left under a backend name that is not connected yet.
    fn leave_restored_profile(settings: &AppSettingsManager, name: &str) {
        for section in [SUB_REMOTES, SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            let sub = settings.sub_settings(section).unwrap();
            let profiles = sub.profiles().unwrap();
            profiles.create(name).unwrap();
            sub.switch_profile(name).unwrap();
            sub.set("restored", &serde_json::json!({"name": "restored"}))
                .unwrap();
            sub.switch_profile(crate::utils::constants::LOCAL_BACKEND_PROFILE)
                .unwrap();
        }
    }

    #[tokio::test]
    async fn an_explicit_copy_replaces_data_a_restore_left_under_the_same_name() {
        let (_directory, settings) = settings_with_profiles(true);
        for section in [SUB_REMOTES, SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            settings
                .sub_settings(section)
                .unwrap()
                .set("local-item", &serde_json::json!({"name": "local"}))
                .unwrap();
        }
        leave_restored_profile(&settings, "NAS");
        let manager = BackendManager::new();

        manager
            .add(
                &settings,
                Backend::new_remote("NAS", "127.0.0.1", 0),
                CopySources {
                    remotes: Some(LOCAL_BACKEND_NAME),
                    flow: Some(LOCAL_BACKEND_NAME),
                    ..CopySources::default()
                },
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "NAS").await.unwrap();

        for section in [SUB_REMOTES, SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            assert_eq!(flow_ids(&settings, section), ["local-item"], "{section}");
        }
    }

    #[tokio::test]
    async fn without_a_copy_source_restored_data_is_kept_for_the_new_backend() {
        let (_directory, settings) = settings_with_profiles(true);
        leave_restored_profile(&settings, "NAS");
        let manager = BackendManager::new();

        manager
            .add(
                &settings,
                Backend::new_remote("NAS", "127.0.0.1", 0),
                CopySources::default(),
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "NAS").await.unwrap();

        for section in [SUB_REMOTES, SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            assert_eq!(flow_ids(&settings, section), ["restored"], "{section}");
        }
    }

    #[tokio::test]
    async fn backend_names_cannot_share_a_profile_directory() {
        let (_directory, settings) = settings_with_profiles(true);
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("NAS", "127.0.0.1", 0),
                CopySources::default(),
            )
            .await
            .unwrap();

        // Local's profile is `default`; `nas` would share `NAS`'s directory.
        for name in ["nas", "default", "Default", "NAS"] {
            let result = manager
                .add(
                    &settings,
                    Backend::new_remote(name, "127.0.0.1", 0),
                    CopySources::default(),
                )
                .await;
            assert!(result.is_err(), "{name} was accepted");
        }
        assert_eq!(manager.list_all().await.len(), 2);
    }

    #[tokio::test]
    async fn removing_a_backend_deletes_all_of_its_profiles() {
        let (_directory, settings) = settings_with_profiles(true);
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Gone", "127.0.0.1", 0),
                CopySources::default(),
            )
            .await
            .unwrap();
        for section in ENGINE_SUB_SETTINGS {
            assert!(
                settings
                    .sub_settings(section)
                    .unwrap()
                    .profiles()
                    .unwrap()
                    .exists("Gone")
                    .unwrap()
            );
        }

        manager.remove(&settings, "Gone").await.unwrap();
        for section in ENGINE_SUB_SETTINGS {
            assert!(
                !settings
                    .sub_settings(section)
                    .unwrap()
                    .profiles()
                    .unwrap()
                    .exists("Gone")
                    .unwrap()
            );
        }
    }

    #[tokio::test]
    async fn failed_backend_profile_switch_restores_remote_profile() {
        let (_directory, settings) = settings_with_profiles(false);
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Other", "127.0.0.1", 0),
                CopySources::default(),
            )
            .await
            .unwrap();
        settings
            .sub_settings("remotes")
            .unwrap()
            .set("drive", &serde_json::json!({ "primaryActions": ["local"] }))
            .unwrap();

        assert!(manager.switch_to(&settings, "Other").await.is_err());
        assert_eq!(manager.get_active_name().await, LOCAL_BACKEND_NAME);
        let (_, remote) = manager
            .active_remote_settings(&settings, "drive", Some(LOCAL_BACKEND_NAME))
            .await
            .unwrap();
        assert_eq!(remote.primary_actions.unwrap(), ["local"]);
    }

    #[tokio::test]
    async fn mount_and_serve_results_stay_with_their_backend_after_switching() {
        use crate::utils::types::remotes::{MountedRemote, ServeInstance};
        let (_directory, settings) = settings_with_profiles(true);
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Other", "127.0.0.1", 0),
                CopySources::default(),
            )
            .await
            .unwrap();
        let local = manager.remote_cache().await;
        local
            .preseed_mount_metadata(MountedRemote::new("local:", "/mount"))
            .await;
        local
            .preseed_serve_metadata(ServeInstance::new(
                "http-1",
                "local:8080",
                serde_json::json!({}),
            ))
            .await;

        manager.switch_to(&settings, "Other").await.unwrap();
        let other = manager.remote_cache().await;
        other
            .preseed_mount_metadata(MountedRemote::new("other:", "/mount"))
            .await;
        other
            .preseed_serve_metadata(ServeInstance::new(
                "http-1",
                "other:8080",
                serde_json::json!({}),
            ))
            .await;
        // A late result from Local is written after the other backend is selected.
        let mut late = MountedRemote::new("local:", "/mount");
        late.profile = Some("late-local-result".into());
        local.preseed_mount_metadata(late).await;
        assert!(
            other
                .get_mount_by_point("/mount")
                .await
                .unwrap()
                .profile
                .is_none()
        );
        assert_eq!(
            other.get_serve_by_id("http-1").await.unwrap().addr,
            "other:8080"
        );

        manager
            .switch_to(&settings, LOCAL_BACKEND_NAME)
            .await
            .unwrap();
        let restored = manager.remote_cache().await;
        assert!(Arc::ptr_eq(&restored, &local));
        assert_eq!(
            restored
                .get_mount_by_point("/mount")
                .await
                .unwrap()
                .profile
                .as_deref(),
            Some("late-local-result")
        );
        assert_eq!(
            restored.get_serve_by_id("http-1").await.unwrap().addr,
            "local:8080"
        );
    }

    #[tokio::test]
    async fn active_operation_counts_include_backends_outside_the_selection() {
        use crate::rclone::commands::job::JobMetadata;
        use crate::utils::types::{
            jobs::JobType,
            remotes::{MountedRemote, ServeInstance},
        };
        let manager = BackendManager::new();
        for name in ["A", "B"] {
            manager
                .job_cache_for(name)
                .create_job(
                    7,
                    JobMetadata::new("drive", JobType::Copy, vec!["src".into()], "dst"),
                    name.into(),
                )
                .await;
        }
        let remotes = manager.remote_cache_for("A");
        remotes
            .preseed_mount_metadata(MountedRemote::new("drive:", "/mount"))
            .await;
        remotes
            .preseed_serve_metadata(ServeInstance::new(
                "http-1",
                "localhost:8080",
                serde_json::json!({}),
            ))
            .await;
        assert_eq!(manager.get_active_name().await, LOCAL_BACKEND_NAME);
        assert_eq!(manager.active_operation_counts().await, (2, 1, 1));
        manager
            .job_cache_for("A")
            .complete_job(7, true, None)
            .await
            .unwrap();
        assert_eq!(manager.active_operation_counts().await, (1, 1, 1));
    }

    #[tokio::test]
    async fn test_new_manager() {
        let manager = BackendManager::new();
        let backends = manager.list_all().await;
        assert_eq!(backends.len(), 1);
        assert_eq!(backends[0].name, LOCAL_BACKEND_NAME);
        assert!(backends[0].is_active);
    }

    #[tokio::test]
    async fn test_set_runtime_status() {
        use crate::rclone::backend::runtime::RuntimeStatus;
        let manager = BackendManager::new();
        manager
            .set_runtime_status(LOCAL_BACKEND_NAME, RuntimeStatus::Connected)
            .await;

        let backends = manager.list_all().await;
        assert_eq!(backends[0].status, Some(RuntimeStatus::Connected));

        manager
            .set_runtime_status(
                LOCAL_BACKEND_NAME,
                RuntimeStatus::Error("connection failed".to_string()),
            )
            .await;
        let backends = manager.list_all().await;
        assert_eq!(
            backends[0].status,
            Some(RuntimeStatus::Error("connection failed".to_string()))
        );
    }

    #[tokio::test]
    async fn reloading_settings_keeps_the_running_engine_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let settings = rcman::SettingsManager::builder("backend-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("connections"))
            .build()
            .unwrap();
        // Saved Local entries never contain generated credentials.
        settings
            .sub_settings("connections")
            .unwrap()
            .set(
                LOCAL_BACKEND_NAME,
                &serde_json::json!({ "is_local": true, "host": "127.0.0.1", "port": 51900 }),
            )
            .unwrap();

        let manager = BackendManager::new();
        let mut running = Backend::new_local(LOCAL_BACKEND_NAME);
        running.username = Some("user_1234abcd".into());
        running.password = Some("secret".into());
        running.is_auth_generated = true;
        manager.update(LOCAL_BACKEND_NAME, running).await.unwrap();

        manager.load_from_settings(&settings).await.unwrap();

        let local = manager.get(LOCAL_BACKEND_NAME).await.unwrap();
        assert!(local.has_valid_auth());
        assert!(local.is_auth_generated);
        assert_eq!(local.password.as_deref(), Some("secret"));
    }

    #[tokio::test]
    async fn reloading_settings_applies_saved_remote_connections_and_drops_unsaved_ones() {
        let directory = tempfile::tempdir().unwrap();
        let settings = rcman::SettingsManager::builder("backend-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("connections"))
            .build()
            .unwrap();
        settings
            .sub_settings("connections")
            .unwrap()
            .set(
                "NAS",
                &serde_json::json!({ "is_local": false, "host": "10.0.0.9", "port": 5599 }),
            )
            .unwrap();

        let manager = BackendManager::new();
        for name in ["NAS", "Gone"] {
            manager
                .add(
                    &settings,
                    Backend::new_remote(name, "10.0.0.2", 5572),
                    CopySources::default(),
                )
                .await
                .unwrap();
        }
        manager
            .set_runtime_status("NAS", super::super::runtime::RuntimeStatus::Connected)
            .await;

        manager.load_from_settings(&settings).await.unwrap();

        let nas = manager.get("NAS").await.unwrap();
        assert_eq!((nas.host.as_str(), nas.port), ("10.0.0.9", 5599));
        assert!(manager.get_runtime_info("NAS").await.is_none());
        assert!(manager.get("Gone").await.is_none());
        assert!(manager.get(LOCAL_BACKEND_NAME).await.is_some());
    }

    #[tokio::test]
    async fn test_get_active_name_consistent() {
        // Both reads come from the same lock, so they can never disagree.
        let manager = BackendManager::new();
        assert_eq!(manager.get_active_name().await, LOCAL_BACKEND_NAME);
        assert_eq!(manager.get_active().await.name, LOCAL_BACKEND_NAME);
    }
}
