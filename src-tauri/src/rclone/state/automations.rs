use crate::{
    core::automation::engine::get_next_run,
    utils::types::{
        automation::{
            Automation, AutomationArgs, AutomationStats, AutomationStatus, AutomationType,
        },
        remotes::ProfileParams,
    },
};
use log::info;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use crate::utils::types::events::AUTOMATIONS_CACHE_CHANGED;

// ============================================================================
// CONFIGURATION STRUCTS
// ============================================================================

#[derive(Default, Debug, PartialEq, Clone)]
struct ProfileConfig {
    cron_enabled: Option<bool>,
    cron_expression: Option<String>,
    watch_enabled: Option<bool>,
    watch_delay: Option<u64>,
    source: Option<Value>,
    dest: Option<Value>,
}

impl<'de> Deserialize<'de> for ProfileConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let val = Value::deserialize(deserializer)?;

        // Deserialize using ProfileConfig or fall back if unpartitioned
        let is_partitioned = val.get("app").is_some() || val.get("rclone").is_some();
        let profile: crate::utils::types::remotes::ProfileConfig = if is_partitioned {
            serde_json::from_value(val).unwrap_or_else(|_| {
                crate::utils::types::remotes::ProfileConfig {
                    app: crate::utils::types::remotes::AppConfig::default(),
                    rclone: serde_json::Value::Null,
                }
            })
        } else {
            let app: crate::utils::types::remotes::AppConfig =
                serde_json::from_value(val.clone()).unwrap_or_default();
            crate::utils::types::remotes::ProfileConfig { app, rclone: val }
        };

        let source = if let Value::Object(ref map) = profile.rclone {
            crate::utils::types::remotes::SOURCE_KEYS
                .iter()
                .find_map(|&key| map.get(key).cloned())
        } else {
            None
        };

        let dest = if let Value::Object(ref map) = profile.rclone {
            crate::utils::types::remotes::DEST_KEYS
                .iter()
                .find_map(|&key| map.get(key).cloned())
        } else {
            None
        };

        Ok(ProfileConfig {
            cron_enabled: profile.app.cron_enabled,
            cron_expression: profile.app.cron_expression,
            watch_enabled: profile.app.watch_enabled,
            watch_delay: profile.app.watch_delay,
            source,
            dest,
        })
    }
}

fn normalize_paths(val: Option<&Value>) -> Vec<String> {
    match val {
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => vec![],
    }
}

// ============================================================================
// CACHE UPDATE RESULT
// ============================================================================

/// Returned by `load_from_remote_configs` so callers can act on exactly what
/// changed. The cache itself does not touch the scheduler — all scheduling and
/// unscheduling decisions belong to the caller.
pub struct CacheUpdateResult {
    /// Tasks that did not previously exist and were inserted.
    pub added: Vec<Automation>,
    /// Tasks whose cron expression, args, name, or type changed.
    pub updated: Vec<Automation>,
    /// Tasks removed because they are no longer present in the config.
    /// Callers must unschedule these using the `scheduler_job_id` field.
    pub removed: Vec<Automation>,
}

impl CacheUpdateResult {
    pub fn has_changes(&self) -> bool {
        !self.added.is_empty() || !self.updated.is_empty() || !self.removed.is_empty()
    }
}

// SCHEDULED TASK CACHE
// ============================================================================

#[derive(Clone)]
pub struct AutomationsCache {
    automations: Arc<RwLock<HashMap<String, Automation>>>,
}

impl AutomationsCache {
    pub fn new() -> Self {
        Self {
            automations: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn generate_automation_id(
        backend_name: &str,
        remote_name: &str,
        automation_type: &AutomationType,
        profile_name: &str,
    ) -> String {
        format!("{backend_name}:{remote_name}-{automation_type:?}-{profile_name}")
    }

    /// Load automations from remote configs, preserving existing automation states.
    pub async fn load_from_remote_configs(
        &self,
        all_settings: &Value,
        backend_name: &str,
        app: Option<&AppHandle>,
    ) -> Result<CacheUpdateResult, String> {
        let settings_obj = all_settings
            .as_object()
            .ok_or("Settings is not an object")?;
        let mut automations = Vec::new();

        for (remote_name, remote_settings) in settings_obj {
            automations.extend(self.collect_automations_from_remote(
                backend_name,
                remote_name,
                remote_settings,
            ));
        }

        let result = self
            .sync_automations(backend_name, automations, |t| {
                t.backend_name == backend_name
            })
            .await?;

        if result.has_changes()
            && let Some(app) = app
        {
            let _ = app.emit(AUTOMATIONS_CACHE_CHANGED, "bulk_update");
        }

        Ok(result)
    }

    /// Internal helper to sync a list of automations into the cache within a specific scope.
    async fn sync_automations(
        &self,
        backend_name: &str,
        new_automations: Vec<Automation>,
        scope_predicate: impl Fn(&Automation) -> bool,
    ) -> Result<CacheUpdateResult, String> {
        let active_ids: HashSet<String> = new_automations.iter().map(|t| t.id.clone()).collect();
        let mut added = Vec::new();
        let mut updated = Vec::new();

        for automation in new_automations {
            if let Some(existing) = self.get_automation(&automation.id).await {
                if self.automation_config_changed(&existing, &automation) {
                    self.update_automation_config(&automation.id, &automation)
                        .await?;
                    info!(
                        "✏️ Updated automation: {} ({})",
                        automation.id, backend_name
                    );
                    if let Some(t) = self.get_automation(&automation.id).await {
                        updated.push(t);
                    }
                }
            } else {
                self.add_automation(automation.clone(), None).await?;
                info!("➕ Added automation: {} ({})", automation.id, backend_name);
                added.push(automation);
            }
        }

        // Cleanup stale automations within scope
        let stale: Vec<String> = self
            .get_all_automations()
            .await
            .into_iter()
            .filter(|t| scope_predicate(t) && !active_ids.contains(&t.id))
            .map(|t| t.id)
            .collect();

        let mut removed = Vec::with_capacity(stale.len());
        for id in stale {
            info!("🗑️ Removing stale automation: {id}");
            removed.push(self.remove_automation(&id, None).await?);
        }

        Ok(CacheUpdateResult {
            added,
            updated,
            removed,
        })
    }

    fn collect_automations_from_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        remote_settings: &Value,
    ) -> Vec<Automation> {
        let mut automations = Vec::new();
        let Some(obj) = remote_settings.as_object() else {
            return automations;
        };

        let operations = [
            ("syncConfigs", AutomationType::Sync),
            ("copyConfigs", AutomationType::Copy),
            ("moveConfigs", AutomationType::Move),
            ("bisyncConfigs", AutomationType::Bisync),
        ];

        for (key, automation_type) in operations {
            if let Some(profiles) = obj.get(key).and_then(|v| v.as_object()) {
                for (profile_name, profile_val) in profiles {
                    if let Ok(config) = serde_json::from_value::<ProfileConfig>(profile_val.clone())
                        && let Some(automation) = self.create_automation_struct(
                            backend_name,
                            remote_name,
                            profile_name,
                            &automation_type,
                            &config,
                        )
                    {
                        automations.push(automation);
                    }
                }
            }
        }
        automations
    }

    fn automation_config_changed(&self, existing: &Automation, new: &Automation) -> bool {
        existing.cron_expression != new.cron_expression
            || existing.args != new.args
            || existing.automation_type != new.automation_type
            || existing.watch_enabled != new.watch_enabled
            || existing.watch_delay != new.watch_delay
    }

    async fn update_automation_config(
        &self,
        automation_id: &str,
        new_config: &Automation,
    ) -> Result<(), String> {
        self.update_automation(
            automation_id,
            |t| {
                t.cron_expression = new_config.cron_expression.clone();
                t.args = new_config.args.clone();
                t.automation_type = new_config.automation_type.clone();
                t.next_run = new_config.next_run;
                t.watch_enabled = new_config.watch_enabled;
                t.watch_delay = new_config.watch_delay;
                // Intentionally NOT overwriting `status` — the user's
                // enabled/disabled choice is the source of truth in the cache.
            },
            None,
        )
        .await
        .map(|_| ())
    }

    fn create_automation_struct(
        &self,
        backend_name: &str,
        remote_name: &str,
        profile_name: &str,
        automation_type: &AutomationType,
        config: &ProfileConfig,
    ) -> Option<Automation> {
        let cron_enabled = config.cron_enabled.unwrap_or(false);
        let watch_enabled = config.watch_enabled.unwrap_or(false);

        let cron = if cron_enabled {
            config
                .cron_expression
                .as_ref()
                .filter(|s| !s.is_empty())
                .cloned()
        } else {
            None
        };

        if cron.is_none() && !watch_enabled {
            return None;
        }

        let src_paths = normalize_paths(config.source.as_ref());
        let dst_paths = normalize_paths(config.dest.as_ref());

        if src_paths.is_empty() || dst_paths.is_empty() {
            return None;
        }

        // Validate path counts based on automation type
        match automation_type {
            AutomationType::Bisync => {
                if src_paths.len() != 1 || dst_paths.len() != 1 {
                    return None;
                }
            }
            AutomationType::Sync | AutomationType::Copy | AutomationType::Move => {
                if src_paths.is_empty() || dst_paths.len() != 1 {
                    return None;
                }
            }
        }

        let automation_id =
            Self::generate_automation_id(backend_name, remote_name, automation_type, profile_name);

        let params = ProfileParams {
            remote_name: remote_name.to_string(),
            profile_name: profile_name.to_string(),
            source: Some(crate::utils::types::origin::Origin::Automation),
            no_cache: None,
        };

        let args = AutomationArgs {
            params,
            src_paths,
            dst_paths,
        };

        let next_run = cron.as_ref().and_then(|c| get_next_run(c).ok());

        Some(Automation {
            id: automation_id,
            automation_type: automation_type.clone(),
            remote_name: remote_name.to_string(),
            profile_name: profile_name.to_string(),
            cron_expression: cron,
            status: AutomationStatus::Enabled,
            args,
            backend_name: backend_name.to_string(),
            created_at: chrono::Utc::now(),
            last_run: None,
            next_run,
            last_error: None,
            current_job_id: None,
            scheduler_job_id: None,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
            stopped_count: 0,
            watch_enabled,
            watch_delay: config.watch_delay.unwrap_or(5),
        })
    }

    // ============================================================================
    // STANDARD OPERATIONS
    // ============================================================================

    pub async fn add_automation(
        &self,
        automation: Automation,
        app: Option<&AppHandle>,
    ) -> Result<Automation, String> {
        let automation_id = automation.id.clone();
        let mut automations = self.automations.write().await;

        if automations.contains_key(&automation_id) {
            return Err(format!("Automation with ID {automation_id} already exists"));
        }

        automations.insert(automation_id.clone(), automation.clone());
        drop(automations);
        if let Some(app) = app {
            let _ = app.emit(AUTOMATIONS_CACHE_CHANGED, "automation_added");
        }
        Ok(automation)
    }

    pub async fn get_automation(&self, automation_id: &str) -> Option<Automation> {
        self.automations.read().await.get(automation_id).cloned()
    }

    pub async fn get_all_automations(&self) -> Vec<Automation> {
        self.automations.read().await.values().cloned().collect()
    }

    pub async fn get_automation_by_job_id(&self, job_id: String) -> Option<Automation> {
        self.automations
            .read()
            .await
            .values()
            .find(|t| t.current_job_id == Some(job_id.clone()))
            .cloned()
    }

    pub async fn update_automation(
        &self,
        automation_id: &str,
        update_fn: impl FnOnce(&mut Automation),
        app: Option<&AppHandle>,
    ) -> Result<Automation, String> {
        let mut automations = self.automations.write().await;
        let automation = automations
            .get_mut(automation_id)
            .ok_or_else(|| format!("Automation {automation_id} not found"))?;

        update_fn(automation);
        let updated_automation = automation.clone();
        drop(automations);

        if let Some(app) = app {
            let _ = app.emit(AUTOMATIONS_CACHE_CHANGED, "automation_updated");
        }
        Ok(updated_automation)
    }

    /// Remove an automation from the cache and return it. The caller is responsible
    /// for unscheduling the associated scheduler job via `scheduler_job_id`.
    pub async fn remove_automation(
        &self,
        automation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<Automation, String> {
        let mut automations = self.automations.write().await;
        let automation = automations
            .remove(automation_id)
            .ok_or_else(|| format!("Automation {automation_id} not found"))?;
        drop(automations);
        if let Some(app) = app {
            let _ = app.emit(AUTOMATIONS_CACHE_CHANGED, "automation_removed");
        }
        Ok(automation)
    }

    pub async fn clear_all_automations(&self, app: Option<&AppHandle>) -> Result<(), String> {
        self.automations.write().await.clear();
        if let Some(app) = app {
            let _ = app.emit(AUTOMATIONS_CACHE_CHANGED, "all_cleared");
        }
        Ok(())
    }

    /// Add or update automations derived from a single remote's settings, removing
    /// automations for profiles that no longer have cron/watch enabled.
    pub async fn add_or_update_automation_for_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        remote_settings: &Value,
    ) -> Result<CacheUpdateResult, String> {
        let automations =
            self.collect_automations_from_remote(backend_name, remote_name, remote_settings);
        let prefix = format!("{backend_name}:{remote_name}-");

        self.sync_automations(backend_name, automations, |t| t.id.starts_with(&prefix))
            .await
    }

    /// Remove all automations belonging to a remote and return them. The caller is
    /// responsible for unscheduling their jobs.
    pub async fn remove_automations_for_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        app: Option<&AppHandle>,
    ) -> Result<Vec<Automation>, String> {
        let prefix = format!("{backend_name}:{remote_name}-");
        let to_remove: Vec<String> = self
            .get_all_automations()
            .await
            .into_iter()
            .filter(|t| t.id.starts_with(&prefix))
            .map(|t| t.id)
            .collect();

        let mut removed = Vec::with_capacity(to_remove.len());
        for id in &to_remove {
            removed.push(self.remove_automation(id, None).await?);
        }

        if !removed.is_empty()
            && let Some(app) = app
        {
            let _ = app.emit(AUTOMATIONS_CACHE_CHANGED, "remote_automations_removed");
        }
        Ok(removed)
    }

    /// Toggle an automation status.
    ///
    /// - `Enabled`/`Failed` -> `Disabled`
    /// - `Disabled` -> `Enabled`
    /// - `Running` -> `Stopping` (let the current run finish, then disable)
    /// - `Stopping` -> no-op
    pub async fn toggle_automation_status(
        &self,
        automation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<Automation, String> {
        self.update_automation(
            automation_id,
            |automation| {
                automation.status = match automation.status {
                    AutomationStatus::Enabled | AutomationStatus::Failed => {
                        automation.next_run = None;
                        AutomationStatus::Disabled
                    }
                    AutomationStatus::Disabled => {
                        automation.next_run = automation
                            .cron_expression
                            .as_ref()
                            .and_then(|expr| get_next_run(expr).ok());
                        AutomationStatus::Enabled
                    }
                    AutomationStatus::Running => AutomationStatus::Stopping,
                    AutomationStatus::Stopping => AutomationStatus::Stopping,
                };
            },
            app,
        )
        .await
    }

    pub async fn get_stats(&self) -> AutomationStats {
        let automations = self.automations.read().await;
        let mut stats = AutomationStats {
            total_automations: automations.len(),
            enabled_automations: 0,
            running_automations: 0,
            failed_automations: 0,
            total_runs: 0,
            successful_runs: 0,
            failed_runs: 0,
            stopped_runs: 0,
        };
        for t in automations.values() {
            match t.status {
                AutomationStatus::Enabled => stats.enabled_automations += 1,
                AutomationStatus::Running => stats.running_automations += 1,
                AutomationStatus::Failed => stats.failed_automations += 1,
                _ => {}
            }
            stats.total_runs += t.run_count;
            stats.successful_runs += t.success_count;
            stats.failed_runs += t.failure_count;
            stats.stopped_runs += t.stopped_count;
        }
        stats
    }

    /// Remove all automations for a backend. Returns the evicted automations so the
    /// caller can unschedule their jobs.
    pub async fn clear_backend_automations(&self, backend_name: &str) -> Vec<Automation> {
        let mut automations = self.automations.write().await;
        let mut removed = Vec::new();
        automations.retain(|_, t| {
            if t.backend_name == backend_name {
                removed.push(t.clone());
                false
            } else {
                true
            }
        });
        removed
    }

    pub async fn get_automations_for_backend(&self, backend_name: &str) -> Vec<Automation> {
        self.automations
            .read()
            .await
            .values()
            .filter(|t| t.backend_name == backend_name)
            .cloned()
            .collect()
    }
}

impl Default for AutomationsCache {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Read-only query commands that only touch the cache live here.
/// Commands that coordinate both cache and scheduler live in `commands.rs`.

#[tauri::command]
pub async fn get_automations(app: AppHandle) -> Result<Vec<Automation>, String> {
    let cache = app.state::<AutomationsCache>();
    Ok(cache.get_all_automations().await)
}

#[tauri::command]
pub async fn get_automation(
    app: AppHandle,
    automation_id: String,
) -> Result<Option<Automation>, String> {
    let cache = app.state::<AutomationsCache>();
    Ok(cache.get_automation(&automation_id).await)
}

#[tauri::command]
pub async fn get_automation_stats(app: AppHandle) -> Result<AutomationStats, String> {
    let cache = app.state::<AutomationsCache>();
    Ok(cache.get_stats().await)
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -----------------------------------------------------------------------
    // RemoteConfig deserialization
    // -----------------------------------------------------------------------

    #[test]
    fn test_profile_config_deserialization() {
        let json_data = json!({
            "cronEnabled": true,
            "cronExpression": "0 0 * * *",
            "source": "/src",
            "dest": "/dst"
        });

        let p: ProfileConfig = serde_json::from_value(json_data).unwrap();
        assert_eq!(p.cron_enabled, Some(true));
        assert_eq!(p.cron_expression.as_deref(), Some("0 0 * * *"));
        assert_eq!(p.source.as_ref().and_then(|v| v.as_str()), Some("/src"));
        assert_eq!(p.dest.as_ref().and_then(|v| v.as_str()), Some("/dst"));
    }

    #[test]
    fn test_profile_config_deserialization_aliases() {
        // Sync / Copy / Move aliases
        let json_sync = json!({
            "srcFs": "/src-sync",
            "dstFs": "/dst-sync"
        });
        let p_sync: ProfileConfig = serde_json::from_value(json_sync).unwrap();
        assert_eq!(
            p_sync.source.as_ref().and_then(|v| v.as_str()),
            Some("/src-sync")
        );
        assert_eq!(
            p_sync.dest.as_ref().and_then(|v| v.as_str()),
            Some("/dst-sync")
        );

        // Bisync aliases
        let json_bisync = json!({
            "path1": "/src-bisync",
            "path2": "/dst-bisync"
        });
        let p_bisync: ProfileConfig = serde_json::from_value(json_bisync).unwrap();
        assert_eq!(
            p_bisync.source.as_ref().and_then(|v| v.as_str()),
            Some("/src-bisync")
        );
        assert_eq!(
            p_bisync.dest.as_ref().and_then(|v| v.as_str()),
            Some("/dst-bisync")
        );

        // Mount / Serve aliases
        let json_mount = json!({
            "fs": "/src-mount",
            "mountPoint": "/dst-mount"
        });
        let p_mount: ProfileConfig = serde_json::from_value(json_mount).unwrap();
        assert_eq!(
            p_mount.source.as_ref().and_then(|v| v.as_str()),
            Some("/src-mount")
        );
        assert_eq!(
            p_mount.dest.as_ref().and_then(|v| v.as_str()),
            Some("/dst-mount")
        );
    }

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // Automation ID generation
    // -----------------------------------------------------------------------

    #[test]
    fn test_generate_automation_id() {
        let id = AutomationsCache::generate_automation_id(
            "mybackend",
            "gdrive",
            &AutomationType::Sync,
            "daily",
        );
        assert_eq!(id, "mybackend:gdrive-Sync-daily");
    }

    #[test]
    fn test_generate_automation_id_uniqueness_across_types() {
        let sync_id =
            AutomationsCache::generate_automation_id("b", "r", &AutomationType::Sync, "p");
        let copy_id =
            AutomationsCache::generate_automation_id("b", "r", &AutomationType::Copy, "p");
        assert_ne!(sync_id, copy_id);
    }

    // -----------------------------------------------------------------------
    // create_automation_struct
    // -----------------------------------------------------------------------

    fn make_cache() -> AutomationsCache {
        AutomationsCache::new()
    }

    fn make_full_profile_config(enabled: bool, cron: &str) -> ProfileConfig {
        ProfileConfig {
            cron_enabled: Some(enabled),
            cron_expression: Some(cron.to_string()),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        }
    }

    #[test]
    fn test_create_automation_struct_disabled_returns_none() {
        let cache = make_cache();
        let cfg = make_full_profile_config(false, "* * * * *");
        let result = cache.create_automation_struct("b", "r", "p", &AutomationType::Sync, &cfg);
        assert!(result.is_none(), "disabled automation should return None");
    }

    #[test]
    fn test_create_automation_struct_empty_cron_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some(String::new()),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        let result = cache.create_automation_struct("b", "r", "p", &AutomationType::Sync, &cfg);
        assert!(result.is_none(), "empty cron should return None");
    }

    #[test]
    fn test_create_automation_struct_empty_cron_but_watcher_enabled_returns_some() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some(String::new()),
            watch_enabled: Some(true),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        let result = cache.create_automation_struct("b", "r", "p", &AutomationType::Sync, &cfg);
        assert!(
            result.is_some(),
            "empty cron with watcher enabled should return Some"
        );
        let automation = result.unwrap();
        assert!(automation.watch_enabled);
        assert!(automation.cron_expression.is_none());
    }

    #[test]
    fn test_create_automation_struct_missing_source_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: None,
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct("b", "r", "p", &AutomationType::Sync, &cfg)
                .is_none(),
            "missing source should return None"
        );
    }

    #[test]
    fn test_create_automation_struct_empty_source_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some(json!("")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct("b", "r", "p", &AutomationType::Sync, &cfg)
                .is_none(),
            "empty source should return None"
        );
    }

    #[test]
    fn test_create_automation_struct_missing_dest_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some(json!("/src")),
            dest: None,
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct("b", "r", "p", &AutomationType::Sync, &cfg)
                .is_none(),
            "missing dest should return None"
        );
    }

    #[test]
    fn test_create_automation_struct_empty_dest_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some(json!("/src")),
            dest: Some(json!("")),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct("b", "r", "p", &AutomationType::Sync, &cfg)
                .is_none(),
            "empty dest should return None"
        );
    }

    #[test]
    fn test_create_automation_struct_valid() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        let automation = cache
            .create_automation_struct("backend", "remote", "daily", &AutomationType::Copy, &cfg)
            .expect("should produce an automation");

        assert_eq!(automation.status, AutomationStatus::Enabled);
        assert_eq!(automation.cron_expression.as_deref(), Some("*/5 * * * *"));
        assert_eq!(automation.automation_type, AutomationType::Copy);
        assert!(automation.scheduler_job_id.is_none());
        assert!(automation.current_job_id.is_none());

        assert_eq!(automation.args.src_paths, vec!["/src".to_string()]);
        assert_eq!(automation.args.dst_paths, vec!["/dst".to_string()]);
        assert_eq!(automation.args.params.remote_name, "remote");
        assert_eq!(automation.args.params.profile_name, "daily");
    }

    #[test]
    fn test_create_automation_struct_bisync_constraints() {
        let cache = make_cache();

        // Exactly 1 source and 1 destination is valid
        let cfg_valid = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct(
                    "backend",
                    "remote",
                    "daily",
                    &AutomationType::Bisync,
                    &cfg_valid
                )
                .is_some()
        );

        // Multiple sources is invalid for Bisync
        let cfg_multisrc = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1", "/src2"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct(
                    "backend",
                    "remote",
                    "daily",
                    &AutomationType::Bisync,
                    &cfg_multisrc
                )
                .is_none()
        );

        // Multiple destinations is invalid for Bisync
        let cfg_multidst = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1", "/dst2"])),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct(
                    "backend",
                    "remote",
                    "daily",
                    &AutomationType::Bisync,
                    &cfg_multidst
                )
                .is_none()
        );
    }

    #[test]
    fn test_create_automation_struct_sync_copy_move_constraints() {
        let cache = make_cache();

        // 1 source and 1 destination is valid
        let cfg_one_to_one = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct(
                    "backend",
                    "remote",
                    "daily",
                    &AutomationType::Sync,
                    &cfg_one_to_one
                )
                .is_some()
        );

        // Multiple sources and 1 destination is valid
        let cfg_multi_to_one = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1", "/src2"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct(
                    "backend",
                    "remote",
                    "daily",
                    &AutomationType::Sync,
                    &cfg_multi_to_one
                )
                .is_some()
        );

        // Multiple destinations is invalid
        let cfg_one_to_multi = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1", "/dst2"])),
            ..Default::default()
        };
        assert!(
            cache
                .create_automation_struct(
                    "backend",
                    "remote",
                    "daily",
                    &AutomationType::Sync,
                    &cfg_one_to_multi
                )
                .is_none()
        );
    }

    // -----------------------------------------------------------------------
    // automation_config_changed
    // -----------------------------------------------------------------------

    fn base_automation() -> Automation {
        Automation {
            id: "b:r-sync-p".to_string(),
            automation_type: AutomationType::Sync,
            remote_name: "r".to_string(),
            profile_name: "p".to_string(),
            cron_expression: Some("* * * * *".to_string()),
            status: AutomationStatus::Enabled,
            args: AutomationArgs {
                params: ProfileParams {
                    remote_name: "r".to_string(),
                    profile_name: "p".to_string(),
                    source: None,
                    no_cache: None,
                },
                src_paths: vec![],
                dst_paths: vec![],
            },
            backend_name: "b".to_string(),
            created_at: chrono::Utc::now(),
            last_run: None,
            next_run: None,
            last_error: None,
            current_job_id: None,
            scheduler_job_id: None,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
            stopped_count: 0,
            watch_enabled: false,
            watch_delay: 5,
        }
    }

    #[test]
    fn test_automation_config_changed_same() {
        let cache = make_cache();
        let a = base_automation();
        let b = base_automation();
        assert!(!cache.automation_config_changed(&a, &b));
    }

    #[test]
    fn test_automation_config_changed_cron() {
        let cache = make_cache();
        let a = base_automation();
        let mut b = base_automation();
        b.cron_expression = Some("0 9 * * 1-5".to_string());
        assert!(cache.automation_config_changed(&a, &b));
    }

    #[test]
    fn test_automation_config_changed_status_ignored() {
        let cache = make_cache();
        let a = base_automation();
        let mut b = base_automation();
        b.status = AutomationStatus::Disabled;
        assert!(!cache.automation_config_changed(&a, &b));
    }

    // -----------------------------------------------------------------------
    // Cache CRUD
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_add_and_get_automation() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();

        cache
            .add_automation(automation.clone(), None)
            .await
            .unwrap();
        let fetched = cache.get_automation(&id).await.unwrap();
        assert_eq!(fetched.id, id);
    }

    #[tokio::test]
    async fn test_add_duplicate_automation_returns_error() {
        let cache = make_cache();
        let automation = base_automation();
        cache
            .add_automation(automation.clone(), None)
            .await
            .unwrap();
        let result = cache.add_automation(automation, None).await;
        assert!(result.is_err(), "duplicate insert should fail");
    }

    #[tokio::test]
    async fn test_get_nonexistent_automation_returns_none() {
        let cache = make_cache();
        assert!(cache.get_automation("does-not-exist").await.is_none());
    }

    #[tokio::test]
    async fn test_update_automation() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();
        cache.add_automation(automation, None).await.unwrap();

        let updated = cache
            .update_automation(&id, |t| t.run_count += 1, None)
            .await
            .unwrap();
        assert_eq!(updated.run_count, 1);

        let fetched = cache.get_automation(&id).await.unwrap();
        assert_eq!(fetched.run_count, 1);
    }

    #[tokio::test]
    async fn test_update_nonexistent_automation_returns_error() {
        let cache = make_cache();
        let result = cache.update_automation("ghost", |_| {}, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_automation_returns_automation() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();
        cache
            .add_automation(automation.clone(), None)
            .await
            .unwrap();

        let removed = cache.remove_automation(&id, None).await.unwrap();
        assert_eq!(removed.id, id);
        assert!(
            cache.get_automation(&id).await.is_none(),
            "automation must be gone from cache"
        );
    }

    #[tokio::test]
    async fn test_remove_nonexistent_automation_returns_error() {
        let cache = make_cache();
        let result = cache.remove_automation("ghost", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_automation_preserves_scheduler_job_id() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.scheduler_job_id = Some("550e8400-e29b-41d4-a716-446655440000".to_string());
        let id = automation.id.clone();
        cache.add_automation(automation, None).await.unwrap();

        let removed = cache.remove_automation(&id, None).await.unwrap();
        assert_eq!(
            removed.scheduler_job_id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000"),
            "caller needs scheduler_job_id to unschedule the job"
        );
    }

    #[tokio::test]
    async fn test_get_all_automations() {
        let cache = make_cache();
        let mut t1 = base_automation();
        t1.id = "id1".to_string();
        let mut t2 = base_automation();
        t2.id = "id2".to_string();

        cache.add_automation(t1, None).await.unwrap();
        cache.add_automation(t2, None).await.unwrap();

        let all = cache.get_all_automations().await;
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn test_clear_all_automations() {
        let cache = make_cache();
        cache.add_automation(base_automation(), None).await.unwrap();
        cache.clear_all_automations(None).await.unwrap();
        assert!(cache.get_all_automations().await.is_empty());
    }

    // -----------------------------------------------------------------------
    // clear_backend_automations
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_clear_backend_automations_returns_evicted() {
        let cache = make_cache();

        let mut t1 = base_automation();
        t1.id = "b1:r-sync-p".to_string();
        t1.backend_name = "b1".to_string();
        t1.scheduler_job_id = Some("550e8400-e29b-41d4-a716-446655440000".to_string());

        let mut t2 = base_automation();
        t2.id = "b2:r-sync-p".to_string();
        t2.backend_name = "b2".to_string();

        cache.add_automation(t1, None).await.unwrap();
        cache.add_automation(t2, None).await.unwrap();

        let evicted = cache.clear_backend_automations("b1").await;
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].backend_name, "b1");
        assert!(
            evicted[0].scheduler_job_id.is_some(),
            "job id must survive eviction"
        );
        assert_eq!(
            cache.get_all_automations().await.len(),
            1,
            "b2 automation must remain"
        );
    }

    // -----------------------------------------------------------------------
    // toggle_automation_status
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_toggle_enabled_to_disabled() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Enabled;
        let id = automation.id.clone();
        cache.add_automation(automation, None).await.unwrap();

        let toggled = cache.toggle_automation_status(&id, None).await.unwrap();
        assert_eq!(toggled.status, AutomationStatus::Disabled);
        assert!(toggled.next_run.is_none());
    }

    #[tokio::test]
    async fn test_toggle_failed_to_disabled() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Failed;
        let id = automation.id.clone();
        cache.add_automation(automation, None).await.unwrap();

        let toggled = cache.toggle_automation_status(&id, None).await.unwrap();
        assert_eq!(toggled.status, AutomationStatus::Disabled);
        assert!(toggled.next_run.is_none());
    }

    #[tokio::test]
    async fn test_toggle_disabled_to_enabled() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Disabled;
        let id = automation.id.clone();
        cache.add_automation(automation, None).await.unwrap();

        let toggled = cache.toggle_automation_status(&id, None).await.unwrap();
        assert_eq!(toggled.status, AutomationStatus::Enabled);
    }

    #[tokio::test]
    async fn test_toggle_running_to_stopping() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Running;
        let id = automation.id.clone();
        cache.add_automation(automation, None).await.unwrap();

        let result = cache.toggle_automation_status(&id, None).await.unwrap();
        assert_eq!(
            result.status,
            AutomationStatus::Stopping,
            "toggling a Running automation must transition to Stopping"
        );
    }

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_get_stats_empty() {
        let cache = make_cache();
        let stats = cache.get_stats().await;
        assert_eq!(stats.total_automations, 0);
        assert_eq!(stats.enabled_automations, 0);
        assert_eq!(stats.total_runs, 0);
    }

    #[tokio::test]
    async fn test_get_stats_counts() {
        let cache = make_cache();

        let mut enabled = base_automation();
        enabled.id = "e1".to_string();
        enabled.status = AutomationStatus::Enabled;
        enabled.run_count = 3;
        enabled.success_count = 2;
        enabled.failure_count = 1;

        let mut disabled = base_automation();
        disabled.id = "d1".to_string();
        disabled.status = AutomationStatus::Disabled;

        cache.add_automation(enabled, None).await.unwrap();
        cache.add_automation(disabled, None).await.unwrap();

        let stats = cache.get_stats().await;
        assert_eq!(stats.total_automations, 2);
        assert_eq!(stats.enabled_automations, 1);
        assert_eq!(stats.total_runs, 3);
        assert_eq!(stats.successful_runs, 2);
        assert_eq!(stats.failed_runs, 1);
    }

    // -----------------------------------------------------------------------
    // CacheUpdateResult
    // -----------------------------------------------------------------------

    #[test]
    fn test_cache_update_result_has_changes() {
        let empty = CacheUpdateResult {
            added: vec![],
            updated: vec![],
            removed: vec![],
        };
        assert!(!empty.has_changes());

        let with_removal = CacheUpdateResult {
            added: vec![],
            updated: vec![],
            removed: vec![base_automation()],
        };
        assert!(with_removal.has_changes());
    }

    // -----------------------------------------------------------------------
    // get_automations_for_backend / prefix filtering
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_get_automations_for_backend_filters_correctly() {
        let cache = make_cache();

        let mut t1 = base_automation();
        t1.id = "backend_a:remote-sync-p".to_string();
        t1.backend_name = "backend_a".to_string();

        let mut t2 = base_automation();
        t2.id = "backend_b:remote-sync-p".to_string();
        t2.backend_name = "backend_b".to_string();

        cache.add_automation(t1, None).await.unwrap();
        cache.add_automation(t2, None).await.unwrap();

        let a_automations = cache.get_automations_for_backend("backend_a").await;
        assert_eq!(a_automations.len(), 1);
        assert_eq!(a_automations[0].backend_name, "backend_a");
    }
}
