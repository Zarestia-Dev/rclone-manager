use crate::context::AppHandle;
use log::{error, info};
use serde_json::{Value, json};
use tokio::sync::RwLock;

use crate::{
    rclone::{
        backend::{BackendManager, types::Backend},
        queries::{
            get_all_remote_configs_for_backend, get_mounted_remotes_for_backend,
            list_serves_for_backend,
        },
    },
    services::{flow::quick_run::commands::get_all_quick_runs, settings::AppSettingsManager},
    utils::json_helpers::{extract_remote_name_from_fs, normalize_remote_name},
    utils::types::{
        events::{MOUNT_STATE_CHANGED, REMOTE_CACHE_CHANGED, SERVE_STATE_CHANGED},
        remotes::{
            MountedRemote, OperationType, RemoteCache, RemoteSettings, ServeInstance, dest_path,
            source_paths,
        },
        starter::{self, Starter},
    },
};

impl RemoteCache {
    #[must_use]
    pub fn new() -> Self {
        Self {
            remotes: RwLock::new(None),
            configs: RwLock::new(json!({})),
            mounted: RwLock::new(Vec::new()),
            serves: RwLock::new(Vec::new()),
        }
    }

    // These carry what started the entry (its starter) and the other launch metadata forward
    // from the existing cache entry when the rclone API, which knows nothing of them,
    // returns fresh data.

    fn merge_mount_profiles(
        incoming: Vec<MountedRemote>,
        existing: &[MountedRemote],
    ) -> Vec<MountedRemote> {
        incoming
            .into_iter()
            .map(|mut m| {
                let norm = normalize_mount_path(&m.mount_point);
                if let Some(e) = existing
                    .iter()
                    .find(|e| normalize_mount_path(&e.mount_point) == norm)
                {
                    m.starter = e.starter.clone().or(m.starter);
                    m.execute_id = e.execute_id.clone();
                    m.origin = e.origin.clone();
                    m.mount_type = e.mount_type.clone();
                    m.mounted_on = m.mounted_on.or(e.mounted_on);
                }
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
                if let Some(e) = existing.iter().find(|e| e.id == s.id) {
                    s.starter = e.starter.clone().or(s.starter);
                    s.execute_id = e.execute_id.clone();
                    s.origin = e.origin.clone();
                }
                s
            })
            .collect()
    }

    // REACTIVE CACHE UPDATES — emit events only when data actually changes

    /// Update mounted remotes cache and emit event if changed.
    /// Carries profiles forward from the existing cache. Returns true if changed.
    pub async fn update_mounts_if_changed(&self, new_mounts: Vec<MountedRemote>) -> bool {
        let mut cache = self.mounted.write().await;
        let merged = Self::merge_mount_profiles(new_mounts, &cache);
        if *cache == merged {
            return false;
        }
        *cache = merged;
        drop(cache);

        info!("📡 Mount cache changed");
        crate::services::bridge::emit(MOUNT_STATE_CHANGED, crate::utils::constants::CACHE_UPDATED);

        true
    }

    /// Update serves cache and emit event if changed.
    /// Carries profiles forward from the existing cache. Returns true if changed.
    pub async fn update_serves_if_changed(&self, new_serves: Vec<ServeInstance>) -> bool {
        let mut cache = self.serves.write().await;
        let merged = Self::merge_serve_profiles(new_serves, &cache);
        if *cache == merged {
            return false;
        }
        *cache = merged;
        drop(cache);

        info!("📡 Serve cache changed");
        crate::services::bridge::emit(SERVE_STATE_CHANGED, crate::utils::constants::CACHE_UPDATED);
        true
    }

    // FULL REFRESH — called on startup / backend switch / remote changes

    /// Atomically refreshes both remote configs and remote names from rclone `config/dump`.
    /// Emits `REMOTE_CACHE_CHANGED` to notify subscribers.
    pub async fn refresh_remotes_and_configs(
        &self,
        app: AppHandle,
        backend: &Backend,
    ) -> Result<(), String> {
        match get_all_remote_configs_for_backend(app, backend).await {
            Ok(configs) => {
                let mut remote_names: Vec<String> = configs
                    .as_object()
                    .map(|m| m.keys().cloned().collect())
                    .unwrap_or_default();
                remote_names.sort();

                let mut configs_lock = self.configs.write().await;
                let mut remotes_lock = self.remotes.write().await;

                *configs_lock = configs;
                *remotes_lock = Some(remote_names);

                drop(remotes_lock);
                drop(configs_lock);

                crate::services::bridge::emit(
                    REMOTE_CACHE_CHANGED,
                    crate::utils::constants::CACHE_UPDATED,
                );
                Ok(())
            }
            Err(e) => {
                error!("Failed to fetch remote configs: {e}");
                Err(crate::localized_error!(
                    "backendErrors.cache.fetchConfigFailed"
                ))
            }
        }
    }

    /// Update the mounts from the backend's rclone. A mount new to the cache that the app did not
    /// start gets the saved profile or Quick Run it matches (see [`guess_mount_starter`]); the
    /// settings are read only then, not on every poll.
    pub async fn update_mounts_from_engine(
        &self,
        app: &AppHandle,
        backend: &Backend,
        mut mounts: Vec<MountedRemote>,
    ) -> bool {
        let unknown: Vec<usize> = {
            let known = self.mounted.read().await;
            (0..mounts.len())
                .filter(|&i| {
                    let point = normalize_mount_path(&mounts[i].mount_point);
                    mounts[i].starter.is_none()
                        && !known
                            .iter()
                            .any(|m| normalize_mount_path(&m.mount_point) == point)
                })
                .collect()
        };
        if !unknown.is_empty() && is_active(app, backend).await {
            let saved = saved_starters(app, OperationType::Mount);
            for i in unknown {
                mounts[i].starter = guess_mount_starter(&saved, &mounts[i]);
            }
        }
        self.update_mounts_if_changed(mounts).await
    }

    /// Update the serves from the backend's rclone, as [`Self::update_mounts_from_engine`] does.
    pub async fn update_serves_from_engine(
        &self,
        app: &AppHandle,
        backend: &Backend,
        mut serves: Vec<ServeInstance>,
    ) -> bool {
        let unknown: Vec<usize> = {
            let known = self.serves.read().await;
            (0..serves.len())
                .filter(|&i| {
                    serves[i].starter.is_none() && !known.iter().any(|s| s.id == serves[i].id)
                })
                .collect()
        };
        if !unknown.is_empty() && is_active(app, backend).await {
            let saved = saved_starters(app, OperationType::Serve);
            for i in unknown {
                serves[i].starter = guess_serve_starter(&saved, &serves[i]);
            }
        }
        self.update_serves_if_changed(serves).await
    }

    /// Refresh mounted remotes from rclone API and update cache.
    pub async fn refresh_mounted_remotes(
        &self,
        app: AppHandle,
        backend: &Backend,
    ) -> Result<(), String> {
        match get_mounted_remotes_for_backend(app.clone(), backend).await {
            Ok(remotes) => {
                self.update_mounts_from_engine(&app, backend, remotes).await;
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

    /// Refresh serves from rclone API and update cache.
    pub async fn refresh_serves(&self, app: AppHandle, backend: &Backend) -> Result<(), String> {
        match list_serves_for_backend(app.clone(), backend).await {
            Ok(serves) => {
                self.update_serves_from_engine(&app, backend, serves).await;
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

    /// Remote config loading is required for a usable backend; mount/serve
    /// discovery may fail when those capabilities are unavailable.
    pub async fn refresh_all(&self, app: AppHandle, backend: &Backend) -> Result<(), String> {
        let (remotes, _mounts, _serves) = tokio::join!(
            self.refresh_remotes_and_configs(app.clone(), backend),
            self.refresh_mounted_remotes(app.clone(), backend),
            self.refresh_serves(app, backend),
        );

        // Each refresh logs its own failure, and only the remote configs are required.
        remotes
    }

    /// Register a mount in this backend's cache before reconciling with its API.
    pub async fn preseed_mount_metadata(&self, mount: MountedRemote) {
        let normalized = normalize_mount_path(&mount.mount_point);
        let mut mounts = self.mounted.write().await;
        if let Some(existing) = mounts
            .iter_mut()
            .find(|m| normalize_mount_path(&m.mount_point) == normalized)
        {
            *existing = mount;
        } else {
            mounts.push(mount);
        }
        drop(mounts);
        crate::services::bridge::emit(MOUNT_STATE_CHANGED, crate::utils::constants::CACHE_UPDATED);
    }

    /// Register a serve in this backend's cache before reconciling with its API.
    pub async fn preseed_serve_metadata(&self, serve: ServeInstance) {
        let mut serves = self.serves.write().await;
        if let Some(existing) = serves.iter_mut().find(|s| s.id == serve.id) {
            *existing = serve;
        } else {
            serves.push(serve);
        }
        drop(serves);
        crate::services::bridge::emit(SERVE_STATE_CHANGED, crate::utils::constants::CACHE_UPDATED);
    }

    pub async fn get_mounted_remotes(&self) -> Vec<MountedRemote> {
        self.mounted.read().await.clone()
    }

    pub async fn get_serves(&self) -> Vec<ServeInstance> {
        self.serves.read().await.clone()
    }

    pub async fn get_remotes(&self) -> Vec<String> {
        self.remotes.read().await.clone().unwrap_or_default()
    }

    /// The backend's remote names, or none when they could not be read yet.
    pub async fn known_remotes(&self) -> Option<Vec<String>> {
        self.remotes.read().await.clone()
    }

    pub async fn get_configs(&self) -> serde_json::Value {
        self.configs.read().await.clone()
    }

    pub async fn get_serve_by_id(&self, serve_id: &str) -> Option<ServeInstance> {
        self.serves
            .read()
            .await
            .iter()
            .find(|s| s.id == serve_id)
            .cloned()
    }

    pub async fn get_mount_by_point(&self, mount_point: &str) -> Option<MountedRemote> {
        self.mounted
            .read()
            .await
            .iter()
            .find(|m| m.mount_point == mount_point)
            .cloned()
    }

    /// The running mount started from `profile_name` on `remote_name`.
    pub async fn find_mount_by_profile(
        &self,
        remote_name: &str,
        profile_name: &str,
    ) -> Option<MountedRemote> {
        self.mounted
            .read()
            .await
            .iter()
            .find(|m| {
                fs_belongs_to_remote(&m.fs, remote_name)
                    && starter::profile_name(m.starter.as_ref()) == Some(profile_name)
            })
            .cloned()
    }

    /// The running serve started from `profile_name` on `remote_name`.
    pub async fn find_serve_by_profile(
        &self,
        remote_name: &str,
        profile_name: &str,
    ) -> Option<ServeInstance> {
        self.serves
            .read()
            .await
            .iter()
            .find(|s| {
                serve_belongs_to_remote(s, remote_name)
                    && starter::profile_name(s.starter.as_ref()) == Some(profile_name)
            })
            .cloned()
    }

    // PROFILE RENAME — called when a profile is renamed in settings

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
            if fs_belongs_to_remote(&mount.fs, remote_name)
                && starter::profile_name(mount.starter.as_ref()) == Some(old_name)
            {
                mount.starter = Some(Starter::profile(new_name));
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
            if serve_belongs_to_remote(serve, remote_name)
                && starter::profile_name(serve.starter.as_ref()) == Some(old_name)
            {
                serve.starter = Some(Starter::profile(new_name));
                count += 1;
            }
        }
        count
    }
}

/// Whether an rclone `fs` string (`remote:path`) points into `remote_name`.
///
/// Compares whole remote names, so `gdrive` never matches `gdrive2:`.
#[must_use]
pub fn fs_belongs_to_remote(fs: &str, remote_name: &str) -> bool {
    extract_remote_name_from_fs(fs) == normalize_remote_name(remote_name)
}

/// Whether a serve's source `fs` points into `remote_name`.
#[must_use]
pub fn serve_belongs_to_remote(serve: &ServeInstance, remote_name: &str) -> bool {
    serve
        .params
        .get("fs")
        .and_then(|v| v.as_str())
        .is_some_and(|fs| fs_belongs_to_remote(fs, remote_name))
}

/// Check if a path is a local path (i.e. not a remote path).
///
/// Logically, a path in rclone is local if it does not refer to a remote config.
/// Historically, we checked if it started with `/`, `\`, or had a Windows drive letter (e.g., `C:`).
/// More robustly, we check if it has a colon `:` and the part before the colon is not a drive letter
/// and doesn't contain path separators.
#[must_use]
pub fn is_local_path(path: &str) -> bool {
    // If there is no colon, it's definitely a local path
    let Some(colon_idx) = path.find(':') else {
        return true;
    };

    // If the colon is at index 1 (like C: or C:\), it's a drive letter (local path)
    if colon_idx == 1 {
        return true;
    }

    // If there is a path separator before the first colon, the colon is part of the path (local path)
    let remote_part = &path[..colon_idx];
    if remote_part.contains('/') || remote_part.contains('\\') {
        return true;
    }

    // Otherwise, it starts with a remote name (e.g., "remote:path"), so it's not a local path
    false
}

pub async fn get_cached_remotes(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .state::<BackendManager>()
        .remote_cache()
        .await
        .get_remotes()
        .await)
}

pub async fn get_configs(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(app
        .state::<BackendManager>()
        .remote_cache()
        .await
        .get_configs()
        .await)
}

/// Get all remote settings from rcman sub-settings (including orphaned remotes)
pub async fn get_settings(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, crate::utils::types::remotes::RemoteSettings>, String>
{
    let manager = app.state::<AppSettingsManager>();
    Ok(crate::utils::types::remotes::RemoteSettings::load_all(
        manager.inner(),
    ))
}

pub async fn get_cached_mounted_remotes(app: AppHandle) -> Result<Vec<MountedRemote>, String> {
    Ok(app
        .state::<BackendManager>()
        .remote_cache()
        .await
        .get_mounted_remotes()
        .await)
}

pub async fn get_cached_serves(app: AppHandle) -> Result<Vec<ServeInstance>, String> {
    Ok(app
        .state::<BackendManager>()
        .remote_cache()
        .await
        .get_serves()
        .await)
}

/// Rename a profile in all cached mounts
pub async fn rename_mount_profile_in_cache(
    app: AppHandle,
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let updated = app
        .state::<BackendManager>()
        .remote_cache()
        .await
        .rename_profile_in_mounts(&remote_name, &old_name, &new_name)
        .await;

    if updated > 0 {
        crate::services::bridge::emit(MOUNT_STATE_CHANGED, crate::utils::constants::CACHE_UPDATED);
    }

    Ok(updated)
}

/// Rename a profile in all cached serves
pub async fn rename_serve_profile_in_cache(
    app: AppHandle,
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let updated = app
        .state::<BackendManager>()
        .remote_cache()
        .await
        .rename_profile_in_serves(&remote_name, &old_name, &new_name)
        .await;

    if updated > 0 {
        crate::services::bridge::emit(SERVE_STATE_CHANGED, crate::utils::constants::CACHE_UPDATED);
    }

    Ok(updated)
}

/// Normalize a mount path for robust equality comparison across platforms and slashes.
pub fn normalize_mount_path(path: &str) -> String {
    let p = path.replace('\\', "/");
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() {
        p
    } else {
        trimmed.to_string()
    }
}

/// Saved profiles and Quick Runs only belong to the selected backend: its settings are the ones
/// loaded.
async fn is_active(app: &AppHandle, backend: &Backend) -> bool {
    app.state::<BackendManager>().get_active_name().await == backend.name
}

/// The saved profiles and Quick Runs of `operation`, each with its rclone options: the profiles
/// by remote and name, then the Quick Runs by name, so the same one is guessed every time.
fn saved_starters(app: &AppHandle, operation: OperationType) -> Vec<(Starter, Value)> {
    let manager = app.state::<AppSettingsManager>();
    let mut remotes: Vec<_> = RemoteSettings::load_all(&manager).into_iter().collect();
    remotes.sort_by(|(a, _), (b, _)| a.cmp(b));
    let mut saved = Vec::new();
    for (_, remote) in remotes {
        let profiles = match operation {
            OperationType::Mount => remote.mount_configs,
            _ => remote.serve_configs,
        };
        let mut profiles: Vec<_> = profiles.into_iter().flatten().collect();
        profiles.sort_by(|(a, _), (b, _)| a.cmp(b));
        for (name, profile) in profiles {
            saved.push((Starter::profile(name), profile.rclone));
        }
    }
    let quick_runs = get_all_quick_runs(&manager).unwrap_or_default();
    for run in quick_runs
        .into_iter()
        .filter(|run| run.operation_type == operation)
    {
        let rclone = run.config.get("rclone").cloned().unwrap_or_default();
        saved.push((Starter::quick_run(run.id, run.name, None), rclone));
    }
    saved
}

/// The first saved entry whose options match. Two that match start the same mount or serve,
/// of which only one can run.
fn first_match(saved: &[(Starter, Value)], matches: impl Fn(&Value) -> bool) -> Option<Starter> {
    saved
        .iter()
        .find(|(_, rclone)| matches(rclone))
        .map(|(starter, _)| starter.clone())
}

fn same_source(rclone: &Value, fs: &str) -> bool {
    source_paths(rclone)
        .first()
        .is_some_and(|source| source.trim_end_matches('/') == fs.trim_end_matches('/'))
}

/// What started a mount the app does not remember starting: one from before the app connected
/// to this rclone, or from outside the app. rclone only tells its source and mount point, so it
/// is the saved profile or Quick Run with the same two.
fn guess_mount_starter(saved: &[(Starter, Value)], mount: &MountedRemote) -> Option<Starter> {
    let mount_point = normalize_mount_path(&mount.mount_point);
    first_match(saved, |rclone| {
        same_source(rclone, &mount.fs)
            && dest_path(rclone).is_some_and(|dest| normalize_mount_path(&dest) == mount_point)
    })
}

/// What started a serve the app does not remember starting, as for a mount: rclone keeps the
/// options a serve was started with, of which the source, the type and the address tell a saved
/// serve from another of the same remote.
fn guess_serve_starter(saved: &[(Starter, Value)], serve: &ServeInstance) -> Option<Starter> {
    // One address is sent as a string, several as a list.
    fn addresses(value: Option<&Value>) -> Vec<&str> {
        match value {
            Some(Value::String(address)) => vec![address.as_str()],
            Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        }
    }
    let params = &serve.params;
    let fs = params.get("fs").and_then(Value::as_str)?;
    first_match(saved, |rclone| {
        same_source(rclone, fs)
            && rclone.get("type") == params.get("type")
            && addresses(rclone.get("addr")) == addresses(params.get("addr"))
    })
}

impl Default for RemoteCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::starter::WorkflowRun;

    #[tokio::test]
    async fn failed_remote_config_fetch_is_not_reported_as_a_successful_refresh() {
        let cache = RemoteCache::new();
        // No RcloneState/client is registered, so config loading must fail
        // before opening any network connection.
        let result = cache
            .refresh_all(
                AppHandle::default(),
                &Backend::new_remote("offline", "127.0.0.1", 0),
            )
            .await;
        assert!(
            result
                .unwrap_err()
                .contains("backendErrors.cache.fetchConfigFailed")
        );
    }

    fn profiled_mount(fs: &str, mount_point: &str, profile: &str) -> MountedRemote {
        let mut mount = MountedRemote::new(fs, mount_point);
        mount.starter = Some(Starter::profile(profile));
        mount
    }

    #[test]
    fn fs_matches_whole_remote_names_only() {
        assert!(fs_belongs_to_remote("gdrive:", "gdrive"));
        assert!(fs_belongs_to_remote("gdrive:photos/2024", "gdrive:"));
        assert!(fs_belongs_to_remote("Mega{abc12}:docs", "Mega"));
        assert!(!fs_belongs_to_remote("gdrive2:photos", "gdrive"));
        assert!(!fs_belongs_to_remote("gdrive:", "gdrive2"));
        assert!(!fs_belongs_to_remote("", "gdrive"));
    }

    #[tokio::test]
    async fn profile_lookups_are_scoped_to_their_remote() {
        let cache = RemoteCache::new();
        let serve = |id: &str, fs: &str| {
            let mut serve = ServeInstance::new(id, "127.0.0.1:1", json!({ "fs": fs }));
            serve.starter = Some(Starter::profile("Default"));
            serve
        };
        *cache.serves.write().await = vec![serve("a", "alpha:data"), serve("b", "beta:")];
        *cache.mounted.write().await = vec![
            profiled_mount("alpha:data", "/mnt/a", "Default"),
            profiled_mount("beta:", "/mnt/b", "Default"),
        ];

        assert_eq!(
            cache
                .find_serve_by_profile("beta", "Default")
                .await
                .unwrap()
                .id,
            "b"
        );
        assert_eq!(
            cache
                .find_serve_by_profile("alpha", "Default")
                .await
                .unwrap()
                .id,
            "a"
        );
        assert!(
            cache
                .find_serve_by_profile("alpha", "Other")
                .await
                .is_none()
        );
        assert!(
            cache
                .find_serve_by_profile("alph", "Default")
                .await
                .is_none()
        );
        assert_eq!(
            cache
                .find_mount_by_profile("beta", "Default")
                .await
                .unwrap()
                .mount_point,
            "/mnt/b"
        );
        assert!(
            cache
                .find_mount_by_profile("gamma", "Default")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn profile_rename_does_not_touch_a_remote_with_a_longer_name() {
        let cache = RemoteCache::new();
        *cache.mounted.write().await = vec![
            profiled_mount("gdrive2:", "/mnt/2", "old"),
            profiled_mount("gdrive:", "/mnt/1", "old"),
        ];
        assert_eq!(
            cache.rename_profile_in_mounts("gdrive", "old", "new").await,
            1
        );
        let mounts = cache.mounted.read().await;
        assert_eq!(
            starter::profile_name(mounts[0].starter.as_ref()),
            Some("old")
        );
        assert_eq!(
            starter::profile_name(mounts[1].starter.as_ref()),
            Some("new")
        );
    }

    #[tokio::test]
    async fn renaming_a_profile_leaves_quick_runs_of_the_same_name_alone() {
        let cache = RemoteCache::new();
        let mut quick_run = MountedRemote::new("gdrive:", "/mnt/qr");
        quick_run.starter = Some(Starter::quick_run("qr-1", "old", None));
        *cache.mounted.write().await = vec![quick_run, profiled_mount("gdrive:", "/mnt/p", "old")];
        assert_eq!(
            cache.rename_profile_in_mounts("gdrive", "old", "new").await,
            1
        );
        let mounts = cache.mounted.read().await;
        assert_eq!(
            mounts[0].starter,
            Some(Starter::quick_run("qr-1", "old", None))
        );
        assert_eq!(
            starter::profile_name(mounts[1].starter.as_ref()),
            Some("new")
        );
    }

    #[test]
    fn test_normalize_mount_path() {
        assert_eq!(normalize_mount_path("/mnt/drive/"), "/mnt/drive");
        assert_eq!(normalize_mount_path("/mnt/drive"), "/mnt/drive");
        assert_eq!(normalize_mount_path(r"C:\mnt\drive\"), "C:/mnt/drive");
        assert_eq!(normalize_mount_path(r"C:\mnt\drive"), "C:/mnt/drive");
        assert_eq!(normalize_mount_path("/"), "/");
    }

    #[test]
    fn test_merge_mount_profiles_preserves_metadata() {
        let existing = vec![MountedRemote {
            fs: "drive:".to_string(),
            mount_point: "/mnt/drive".to_string(),
            starter: Some(Starter::quick_run(
                "qr-123",
                "Nightly",
                Some(WorkflowRun::new(
                    "wf-1",
                    "Workflow",
                    "node-1",
                    vec!["wf-0".into()],
                )),
            )),
            origin: Some(crate::utils::types::origin::Origin::Dashboard),
            execute_id: Some("exec-1".to_string()),
            mounted_on: None,
            mount_type: Some("cmount".to_string()),
        }];

        // Incoming mount from rclone with trailing slash
        let mut incoming = vec![MountedRemote::new("drive:", "/mnt/drive/")];
        let mounted_on = chrono::DateTime::parse_from_rfc3339("2026-11-19T10:00:00.5+01:00")
            .unwrap()
            .to_utc();
        incoming[0].mounted_on = Some(mounted_on);

        let merged = RemoteCache::merge_mount_profiles(incoming, &existing);
        assert_eq!(merged.len(), 1);
        assert_eq!(
            merged[0].starter,
            Some(Starter::quick_run(
                "qr-123",
                "Nightly",
                Some(WorkflowRun::new(
                    "wf-1",
                    "Workflow",
                    "node-1",
                    vec!["wf-0".into()]
                ))
            ))
        );
        assert_eq!(merged[0].execute_id.as_deref(), Some("exec-1"));
        assert_eq!(
            merged[0].origin,
            Some(crate::utils::types::origin::Origin::Dashboard)
        );
        // rclone knows when it mounted, not which type the app asked for.
        assert_eq!(merged[0].mounted_on, Some(mounted_on));
        assert_eq!(merged[0].mount_type.as_deref(), Some("cmount"));
    }

    #[test]
    fn test_is_local_path() {
        // Local path cases
        assert!(is_local_path("/absolute/path/on/linux"));
        assert!(is_local_path("relative/path/on/linux"));
        assert!(is_local_path(r"C:\absolute\path\on\windows"));
        assert!(is_local_path(r"d:\some\path"));
        assert!(is_local_path("c:relative/path"));
        assert!(is_local_path(r"\relative\backslash\path"));
        assert!(is_local_path("/path/with:colon/in/middle"));
        assert!(is_local_path(""));

        // Remote path cases
        assert!(!is_local_path("remote:"));
        assert!(!is_local_path("my-remote:bucket/file.txt"));
        assert!(!is_local_path("s3:path"));
        assert!(!is_local_path("folder:name/file.txt"));
    }

    #[tokio::test]
    async fn test_update_mounts_preserves_profiles_and_detects_changes() {
        let cache = RemoteCache::new();
        let mounts1 = vec![MountedRemote {
            fs: "drive:".to_string(),
            mount_point: "/mnt/drive".to_string(),
            starter: Some(Starter::profile("profile-a")),
            origin: None,
            execute_id: None,
            mounted_on: None,
            mount_type: None,
        }];

        // Initial update: should return true (changed from empty)
        let changed = cache.update_mounts_if_changed(mounts1.clone()).await;
        assert!(changed);
        assert_eq!(cache.get_mounted_remotes().await.len(), 1);

        // Same mounts: should return false (no change)
        let changed_same = cache.update_mounts_if_changed(mounts1).await;
        assert!(!changed_same);
    }

    #[tokio::test]
    async fn test_update_serves_preserves_profiles_and_detects_changes() {
        let cache = RemoteCache::new();
        let serves1 = vec![ServeInstance {
            id: "serve-1".to_string(),
            addr: "127.0.0.1:8080".to_string(),
            params: json!({"fs": "myremote:"}),
            starter: Some(Starter::profile("srv-profile")),
            origin: None,
            execute_id: None,
        }];

        // Initial update: should return true (changed from empty)
        let changed = cache.update_serves_if_changed(serves1.clone()).await;
        assert!(changed);
        assert_eq!(cache.get_serves().await.len(), 1);

        // Same serves: should return false (no change)
        let changed_same = cache.update_serves_if_changed(serves1).await;
        assert!(!changed_same);
    }

    #[test]
    fn a_mount_gets_the_saved_entry_with_its_source_and_mount_point() {
        let saved = [
            (
                Starter::profile("Photos"),
                json!({"fs": "dropbox:photos", "mountPoint": "U:"}),
            ),
            (
                Starter::profile("Default"),
                json!({"fs": "dropbox:", "mountPoint": "U:/"}),
            ),
            (
                Starter::quick_run("qr-1", "Same", None),
                json!({"fs": "dropbox:/", "mountPoint": "U:\\"}),
            ),
        ];
        // The first of the two that match, whatever separator the paths end in.
        assert_eq!(
            guess_mount_starter(&saved, &MountedRemote::new("dropbox:", "U:")),
            Some(Starter::profile("Default"))
        );
        assert_eq!(
            guess_mount_starter(&saved, &MountedRemote::new("dropbox:photos", "U:")),
            Some(Starter::profile("Photos"))
        );
        for (fs, point) in [
            ("dropbox:", "V:"),
            ("drive:", "U:"),
            ("dropbox:other", "U:"),
        ] {
            assert_eq!(
                guess_mount_starter(&saved, &MountedRemote::new(fs, point)),
                None
            );
        }
    }

    #[test]
    fn a_serve_gets_the_saved_entry_with_its_source_type_and_address() {
        let saved = [
            (
                Starter::profile("Web"),
                json!({"fs": "drive:", "type": "http", "addr": ["localhost:8080"]}),
            ),
            (
                Starter::profile("Dav"),
                json!({"fs": "drive:", "type": "webdav", "addr": "localhost:8080"}),
            ),
            (
                Starter::profile("Default address"),
                json!({"fs": "drive:", "type": "ftp"}),
            ),
        ];
        let serve = |params: Value| ServeInstance::new("id", "[::]:8080", params);
        assert_eq!(
            guess_serve_starter(
                &saved,
                &serve(json!({"fs": "drive:", "type": "http", "addr": "localhost:8080"}))
            ),
            Some(Starter::profile("Web"))
        );
        assert_eq!(
            guess_serve_starter(
                &saved,
                &serve(json!({"fs": "drive:", "type": "webdav", "addr": ["localhost:8080"]}))
            ),
            Some(Starter::profile("Dav"))
        );
        assert_eq!(
            guess_serve_starter(&saved, &serve(json!({"fs": "drive:", "type": "ftp"}))),
            Some(Starter::profile("Default address"))
        );
        for params in [
            json!({"fs": "drive:", "type": "http", "addr": "localhost:9090"}),
            json!({"fs": "drive:", "type": "ftp", "addr": "localhost:2121"}),
            json!({"fs": "box:", "type": "http", "addr": "localhost:8080"}),
            json!({"type": "http"}),
        ] {
            assert_eq!(guess_serve_starter(&saved, &serve(params)), None);
        }
    }

    #[test]
    fn what_the_app_started_wins_over_a_guess() {
        let started = profiled_mount("drive:", "/mnt/drive", "Started");
        let guessed = profiled_mount("drive:", "/mnt/drive/", "Guessed");
        let merged = RemoteCache::merge_mount_profiles(vec![guessed.clone()], &[started]);
        assert_eq!(merged[0].starter, Some(Starter::profile("Started")));
        // An entry the app knows nothing about keeps the guess.
        let unknown = MountedRemote::new("drive:", "/mnt/drive");
        let merged = RemoteCache::merge_mount_profiles(vec![guessed], &[unknown]);
        assert_eq!(merged[0].starter, Some(Starter::profile("Guessed")));
    }

    #[tokio::test]
    async fn only_mounts_new_to_the_cache_are_guessed() {
        // `AppHandle::default()` has no settings, so a guess would fail; a known entry never
        // reaches it, and an inactive backend is not guessed for.
        let cache = RemoteCache::new();
        let app = AppHandle::default();
        let backend = Backend::new_remote("Other", "127.0.0.1", 0);
        cache
            .update_mounts_if_changed(vec![MountedRemote::new("drive:", "/mnt")])
            .await;
        cache
            .update_mounts_from_engine(&app, &backend, vec![MountedRemote::new("drive:", "/mnt/")])
            .await;
        assert_eq!(cache.get_mounted_remotes().await[0].starter, None);
    }
}
