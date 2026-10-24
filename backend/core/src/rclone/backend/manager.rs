use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use log::info;
use parking_lot::RwLock as SyncRwLock;
use tokio::sync::RwLock;

use crate::services::settings::AppSettingsManager;
use crate::utils::constants::LOCAL_BACKEND_NAME;
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
    pub async fn get_local_config_path(&self) -> Result<Option<PathBuf>, String> {
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

        info!("Adding backend: {}", backend.name);

        let setup_profile = |sub_name: &str, source: Option<&str>| {
            if let Ok(sub) = manager.sub_settings(sub_name)
                && let Ok(pm) = sub.profiles()
            {
                match source {
                    Some(src) => {
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

        info!("Updating backend: {name}");
        state.backends[index] = backend;
        Ok(())
    }

    /// Remove a backend by name and delete its associated profiles
    pub async fn remove(&self, manager: &AppSettingsManager, name: &str) -> Result<(), String> {
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

        self.switch_sub_settings_profile(manager, "remotes", profile_name)?;
        if let Err(error) = self.switch_sub_settings_profile(manager, "backend", profile_name) {
            if let Err(rollback_error) = self.switch_sub_settings_profile(
                manager,
                "remotes",
                Backend::profile_name_for(&current_name),
            ) {
                log::error!(
                    "Failed to restore remote settings after backend switch: {rollback_error}"
                );
            }
            return Err(error);
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
            log::info!("Switched '{sub_name}' to profile: {profile_name}");
            Ok(())
        } else {
            log::error!("Failed to access '{sub_name}' sub-settings");
            Err(format!("Failed to access '{sub_name}' sub-settings"))
        }
    }

    /// Set runtime info for a backend (used by connectivity module)
    pub(crate) async fn set_runtime_info(&self, name: &str, info: RuntimeInfo) {
        log::debug!(
            "Backend '{name}' runtime: os={:?}, arch={:?}, go={:?}",
            info.os,
            info.arch,
            info.go_version
        );
        self.runtime_info
            .write()
            .await
            .insert(name.to_string(), info);
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

    /// Get the runtime config path for a specific backend
    pub(crate) async fn get_runtime_config_path(&self, name: &str) -> Option<PathBuf> {
        self.runtime_info
            .read()
            .await
            .get(name)
            .and_then(|info| info.config_path.clone())
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

                if Backend::is_local_name(&backend.name) {
                    let _ = self.update(manager, LOCAL_BACKEND_NAME, backend).await;
                } else {
                    let _ = self.add(manager, backend, None, None).await;
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
                    arch: Some("arm64".into()),
                    go_version: Some("go1.26.0".into()),
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
        assert_eq!(updated.arch.as_deref(), Some("arm64"));
        assert_eq!(updated.go_version.as_deref(), Some("go1.26.0"));
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
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles());
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
                    None,
                    None,
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

    #[tokio::test]
    async fn failed_backend_profile_switch_restores_remote_profile() {
        let (_directory, settings) = settings_with_profiles(false);
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Other", "127.0.0.1", 0),
                None,
                None,
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
                None,
                None,
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
    async fn test_get_active_name_consistent() {
        // Both reads come from the same lock, so they can never disagree.
        let manager = BackendManager::new();
        assert_eq!(manager.get_active_name().await, LOCAL_BACKEND_NAME);
        assert_eq!(manager.get_active().await.name, LOCAL_BACKEND_NAME);
    }
}
