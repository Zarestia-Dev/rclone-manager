use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::context::AppHandle;
use log::info;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::{
    services::{
        bridge,
        flow::{quick_run::types::QuickRun, workflow::types::WorkflowDefinition},
    },
    utils::{
        constants::{
            AUTOMATION_ADDED, AUTOMATION_REMOVED, AUTOMATION_UPDATED, AUTOMATIONS_BULK_UPDATE,
            AUTOMATIONS_REMOTE_REMOVED,
        },
        cron::get_next_run,
        types::{
            automation::{Automation, AutomationArgs, AutomationStatus, DEFAULT_WATCH_DELAY},
            events::AUTOMATIONS_CACHE_CHANGED,
            origin::Origin,
            remotes::{
                DEST_KEYS, OperationType, ProfileConfig, ProfileParams, RemoteSettings, SOURCE_KEYS,
            },
        },
    },
};

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

/// Returned by `load_from_remote_configs` so callers can act on exactly what
/// changed. The cache itself does not touch the scheduler — all scheduling and
/// unscheduling decisions belong to the caller.
pub struct CacheUpdateResult {
    /// Tasks that did not previously exist and were inserted.
    pub added: Vec<Automation>,
    /// Tasks whose cron expression, args, name, or type changed.
    pub updated: Vec<Automation>,
    /// Tasks removed because they are no longer present in the config.
    /// Callers must unschedule these by automation ID.
    pub removed: Vec<Automation>,
}

impl CacheUpdateResult {
    pub fn has_changes(&self) -> bool {
        !self.added.is_empty() || !self.updated.is_empty() || !self.removed.is_empty()
    }
}

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
        automation_type: &OperationType,
        profile_name: &str,
    ) -> String {
        format!(
            "remote:{}",
            serde_json::json!([backend_name, remote_name, automation_type, profile_name])
        )
    }

    /// Load automations from remote configs, preserving existing automation states.
    pub async fn load_from_remote_configs(
        &self,
        all_settings: &HashMap<String, RemoteSettings>,
        backend_name: &str,
    ) -> Result<CacheUpdateResult, String> {
        let automations = all_settings
            .iter()
            .flat_map(|(remote_name, settings)| {
                collect_automations_from_remote(backend_name, remote_name, settings)
            })
            .collect();
        self.sync_automations(automations, |t| {
            t.backend_name == backend_name && !t.is_global()
        })
        .await
    }

    /// Load automations from Quick Runs, preserving existing automation states.
    pub async fn load_from_quick_runs(
        &self,
        quick_runs: &[QuickRun],
        backend_name: &str,
    ) -> Result<CacheUpdateResult, String> {
        let automations = quick_runs
            .iter()
            .filter_map(|qr| create_automation_from_quick_run(backend_name, qr))
            .collect();
        self.sync_automations(automations, |t| {
            t.args.params.source == Some(Origin::QuickRun)
        })
        .await
    }

    /// Load automations from Workflows, preserving existing automation states.
    pub async fn load_from_workflows(
        &self,
        workflows: &[WorkflowDefinition],
        backend_name: &str,
    ) -> Result<CacheUpdateResult, String> {
        let automations = workflows
            .iter()
            .filter_map(|wf| create_automation_from_workflow(backend_name, wf))
            .collect();
        self.sync_automations(automations, |t| {
            t.args.params.source == Some(Origin::Workflow)
        })
        .await
    }

    /// Makes the automations within `in_scope` match `new_automations` under one lock, keeping
    /// the state (status, counters) of those that stay. One event announces all of it.
    async fn sync_automations(
        &self,
        new_automations: Vec<Automation>,
        in_scope: impl Fn(&Automation) -> bool,
    ) -> Result<CacheUpdateResult, String> {
        let active_ids: HashSet<String> = new_automations.iter().map(|t| t.id.clone()).collect();
        let mut result = CacheUpdateResult {
            added: Vec::new(),
            updated: Vec::new(),
            removed: Vec::new(),
        };
        {
            let mut automations = self.automations.write().await;
            for automation in new_automations {
                match automations.get_mut(&automation.id) {
                    Some(existing) if automation_config_changed(existing, &automation) => {
                        info!("✏️ Updated automation: {}", automation.id);
                        apply_config(existing, &automation);
                        result.updated.push(existing.clone());
                    }
                    Some(_) => {}
                    None => {
                        info!("➕ Added automation: {}", automation.id);
                        automations.insert(automation.id.clone(), automation.clone());
                        result.added.push(automation);
                    }
                }
            }
            let stale: Vec<String> = automations
                .values()
                .filter(|t| in_scope(t) && !active_ids.contains(&t.id))
                .map(|t| t.id.clone())
                .collect();
            for id in stale {
                info!("🗑️ Removing stale automation: {id}");
                result.removed.extend(automations.remove(&id));
            }
        }
        if result.has_changes() {
            bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATIONS_BULK_UPDATE);
        }
        Ok(result)
    }

    pub async fn add_automation(&self, automation: Automation) -> Result<Automation, String> {
        let automation_id = automation.id.clone();
        let mut automations = self.automations.write().await;

        if automations.contains_key(&automation_id) {
            return Err(crate::localized_error!(
                "backendErrors.automation.alreadyExists",
                "id" => automation_id
            ));
        }

        automations.insert(automation_id, automation.clone());
        drop(automations);
        bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATION_ADDED);
        Ok(automation)
    }

    pub async fn get_automation(&self, automation_id: &str) -> Option<Automation> {
        self.automations.read().await.get(automation_id).cloned()
    }

    pub async fn get_all_automations(&self) -> Vec<Automation> {
        self.automations.read().await.values().cloned().collect()
    }

    /// Acquire execution permission and capture the current configuration under
    /// one write lock. A busy automation grants no second execution.
    pub async fn try_start_automation(
        &self,
        automation_id: &str,
        backend_name: &str,
        expected_args: Option<&AutomationArgs>,
    ) -> Result<Option<Automation>, String> {
        let mut automations = self.automations.write().await;
        let automation = automations.get_mut(automation_id).ok_or_else(|| {
            crate::localized_error!("backendErrors.automation.automationNotFound")
        })?;
        if expected_args.is_some_and(|args| args != &automation.args)
            || !automation.belongs_to_backend(backend_name)
            || matches!(
                automation.status,
                AutomationStatus::Running | AutomationStatus::Stopping
            )
            || automation.current_job_id.is_some()
        {
            return Ok(None);
        }
        automation.mark_starting()?;
        automation.backend_name = backend_name.to_string();
        let started = automation.clone();
        drop(automations);
        bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATION_UPDATED);
        Ok(Some(started))
    }

    pub async fn update_execution(
        &self,
        backend: &str,
        execution: &str,
        update: impl FnOnce(&mut Automation),
    ) -> Option<Automation> {
        let mut automations = self.automations.write().await;
        let automation = automations
            .values_mut()
            .find(|a| a.backend_name == backend && a.execution_id.as_deref() == Some(execution))?;
        update(automation);
        let updated = automation.clone();
        drop(automations);
        bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATION_UPDATED);
        Some(updated)
    }

    pub async fn bind_job_execution(&self, backend: &str, execution: &str, job_id: u64) {
        let bound = {
            let mut automations = self.automations.write().await;
            automations
                .values_mut()
                .find(|a| a.backend_name == backend && a.execution_id.as_deref() == Some(execution))
                .map(|automation| automation.current_job_id = Some(job_id.to_string()))
                .is_some()
        };
        if bound {
            bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATION_UPDATED);
        }
    }

    pub async fn update_automation(
        &self,
        automation_id: &str,
        update_fn: impl FnOnce(&mut Automation),
    ) -> Result<Automation, String> {
        let mut automations = self.automations.write().await;
        let automation = automations.get_mut(automation_id).ok_or_else(|| {
            crate::localized_error!("backendErrors.automation.automationNotFound")
        })?;

        update_fn(automation);
        let updated_automation = automation.clone();
        drop(automations);

        bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATION_UPDATED);
        Ok(updated_automation)
    }

    /// Remove an automation from the cache and return it. The caller is responsible
    /// for unscheduling its job by automation ID.
    pub async fn remove_automation(&self, automation_id: &str) -> Result<Automation, String> {
        let mut automations = self.automations.write().await;
        let automation = automations.remove(automation_id).ok_or_else(|| {
            crate::localized_error!("backendErrors.automation.automationNotFound")
        })?;
        drop(automations);
        bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATION_REMOVED);
        Ok(automation)
    }

    /// Add or update automations derived from a single remote's settings, removing
    /// automations for profiles that no longer have cron/watch enabled.
    pub async fn add_or_update_automation_for_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        remote_settings: &RemoteSettings,
    ) -> Result<CacheUpdateResult, String> {
        let automations =
            collect_automations_from_remote(backend_name, remote_name, remote_settings);
        self.sync_automations(automations, |t| {
            !t.is_global() && t.backend_name == backend_name && t.remote_name == remote_name
        })
        .await
    }

    /// Remove all automations belonging to a remote and return them. The caller is
    /// responsible for unscheduling their jobs.
    pub async fn remove_automations_for_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
    ) -> Result<Vec<Automation>, String> {
        let mut automations = self.automations.write().await;
        let mut removed = Vec::new();
        automations.retain(|_, t| {
            let owned =
                !t.is_global() && t.backend_name == backend_name && t.remote_name == remote_name;
            if owned {
                removed.push(t.clone());
            }
            !owned
        });
        drop(automations);
        if !removed.is_empty() {
            bridge::emit(AUTOMATIONS_CACHE_CHANGED, AUTOMATIONS_REMOTE_REMOVED);
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
    ) -> Result<Automation, String> {
        self.update_automation(automation_id, |automation| {
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
        })
        .await
    }

    /// Remove a backend's remote-profile automations, preserving global definitions.
    /// Returns the evicted automations so the
    /// caller can unschedule their jobs.
    pub async fn clear_backend_automations(&self, backend_name: &str) -> Vec<Automation> {
        let mut automations = self.automations.write().await;
        let mut removed = Vec::new();
        automations.retain(|_, t| {
            if !t.is_global() && t.backend_name == backend_name {
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
            .filter(|t| !t.is_global() && t.backend_name == backend_name)
            .cloned()
            .collect()
    }
}

fn collect_automations_from_remote(
    backend_name: &str,
    remote_name: &str,
    remote_settings: &RemoteSettings,
) -> Vec<Automation> {
    let mut automations = Vec::new();
    for op_type in OperationType::ALL
        .iter()
        .copied()
        .filter(|op| op.is_automation())
    {
        let Some(profiles) = remote_settings.get_configs(op_type) else {
            continue;
        };
        for (profile_name, profile) in profiles {
            automations.extend(create_automation_struct(
                backend_name,
                remote_name,
                profile_name,
                &op_type,
                profile,
            ));
        }
    }
    automations
}

fn automation_config_changed(existing: &Automation, new: &Automation) -> bool {
    existing.cron_expression != new.cron_expression
        || existing.args != new.args
        || existing.automation_type != new.automation_type
        || existing.watch_enabled != new.watch_enabled
        || existing.watch_delay != new.watch_delay
        || existing.watch_changed_only != new.watch_changed_only
}

/// Takes the configuration of `new`. The status stays: the user's enabled/disabled choice
/// is the source of truth in the cache.
fn apply_config(existing: &mut Automation, new: &Automation) {
    existing.cron_expression = new.cron_expression.clone();
    existing.args = new.args.clone();
    existing.automation_type = new.automation_type;
    existing.next_run = new.next_run;
    existing.watch_enabled = new.watch_enabled;
    existing.watch_delay = new.watch_delay;
    existing.watch_changed_only = new.watch_changed_only;
}

/// A new, enabled automation with its schedule and watch settings.
fn scheduled(
    mut automation: Automation,
    cron_expression: Option<String>,
    watch: (bool, u64, bool),
) -> Automation {
    automation.next_run = cron_expression
        .as_deref()
        .and_then(|cron| get_next_run(cron).ok());
    automation.cron_expression = cron_expression;
    (
        automation.watch_enabled,
        automation.watch_delay,
        automation.watch_changed_only,
    ) = watch;
    automation
}

fn create_automation_struct(
    backend_name: &str,
    remote_name: &str,
    profile_name: &str,
    automation_type: &OperationType,
    profile: &ProfileConfig,
) -> Option<Automation> {
    let watch_enabled = profile.app.watch_enabled.unwrap_or(false);
    let cron = profile
        .app
        .cron_enabled
        .unwrap_or(false)
        .then(|| profile.app.cron_expression.clone())
        .flatten()
        .filter(|expression| !expression.is_empty());

    if cron.is_none() && !watch_enabled {
        return None;
    }

    let src_paths = normalize_paths(profile.source_value());
    let dst_paths = normalize_paths(profile.dest_value());

    // Validate path counts based on automation type
    match automation_type {
        OperationType::Delete => {}
        OperationType::Bisync => {
            if src_paths.len() != 1 || dst_paths.len() != 1 {
                return None;
            }
        }
        OperationType::Sync
        | OperationType::Copy
        | OperationType::Move
        | OperationType::Check
        | OperationType::Copyurl
        | OperationType::Archivecreate
        | OperationType::Cryptcheck => {
            if src_paths.is_empty() || dst_paths.len() != 1 {
                return None;
            }
        }
        _ => return None,
    }
    if src_paths.is_empty() {
        return None;
    }

    let args = AutomationArgs {
        params: ProfileParams {
            remote_name: remote_name.to_string(),
            profile_name: profile_name.to_string(),
            backend_name: Some(backend_name.to_string()),
            source: Some(Origin::Automation),
            no_cache: None,
            scoped_targets: None,
            execute_id: None,
        },
        src_paths,
        dst_paths,
    };
    let id = AutomationsCache::generate_automation_id(
        backend_name,
        remote_name,
        automation_type,
        profile_name,
    );
    let changed_only = *automation_type != OperationType::Bisync
        && profile.app.watch_changed_only.unwrap_or(false);
    Some(scheduled(
        Automation::new(id, *automation_type, args, backend_name),
        cron,
        (
            watch_enabled,
            profile.app.watch_delay.unwrap_or(DEFAULT_WATCH_DELAY),
            changed_only,
        ),
    ))
}

/// The first non-empty text found under one of `keys` in a quick run's `rclone` settings.
fn first_text(rclone: Option<&Value>, keys: &[&str]) -> Option<String> {
    let settings = rclone?.as_object()?;
    keys.iter()
        .filter_map(|key| settings.get(*key)?.as_str())
        .find(|text| !text.trim().is_empty())
        .map(str::to_string)
}

fn create_automation_from_quick_run(backend_name: &str, qr: &QuickRun) -> Option<Automation> {
    let cron_enabled = qr.is_cron_enabled();
    let watch_enabled = qr.is_watch_enabled();
    if !cron_enabled && !watch_enabled {
        return None;
    }

    let cron = if cron_enabled {
        qr.cron_expression().filter(|s| !s.is_empty())
    } else {
        None
    };

    let rclone = qr.config.get("rclone");
    let mut src_paths = qr.watch_paths();
    if src_paths.is_empty() {
        src_paths.extend(first_text(rclone, SOURCE_KEYS));
    }
    if src_paths.is_empty() {
        src_paths.push(qr.remote_name.clone());
    }
    let dst_paths: Vec<String> = first_text(rclone, DEST_KEYS).into_iter().collect();

    let args = AutomationArgs {
        params: ProfileParams {
            remote_name: qr.remote_name.clone(),
            profile_name: qr.name.clone(),
            backend_name: None,
            source: Some(Origin::QuickRun),
            no_cache: None,
            scoped_targets: None,
            execute_id: None,
        },
        src_paths,
        dst_paths,
    };
    let app = qr.config.get("app");
    let watch_delay = app
        .and_then(|a| a.get("watchDelay"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_WATCH_DELAY);
    let watch_changed_only = app
        .and_then(|a| a.get("watchChangedOnly"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(scheduled(
        Automation::new(qr.id.clone(), qr.operation_type, args, backend_name),
        cron,
        (watch_enabled, watch_delay, watch_changed_only),
    ))
}

fn create_automation_from_workflow(
    backend_name: &str,
    wf: &WorkflowDefinition,
) -> Option<Automation> {
    let cron_enabled = wf.is_cron_enabled();
    let watch_enabled = wf.is_watch_enabled();
    if !cron_enabled && !watch_enabled {
        return None;
    }

    let cron = if cron_enabled {
        wf.effective_cron_expression()
            .filter(|s| !s.trim().is_empty())
    } else {
        None
    };
    let src_paths = if watch_enabled {
        wf.watcher_paths()
    } else {
        vec![wf.name.clone()]
    };
    // A workflow has no remote and no destination; the automation model needs both filled in.
    let args = AutomationArgs {
        params: ProfileParams {
            remote_name: "Workflow".to_string(),
            profile_name: wf.name.clone(),
            backend_name: None,
            source: Some(Origin::Workflow),
            no_cache: None,
            scoped_targets: None,
            execute_id: None,
        },
        src_paths,
        dst_paths: vec!["Workflow Engine".to_string()],
    };
    Some(scheduled(
        Automation::new(wf.id.clone(), OperationType::Sync, args, backend_name),
        cron,
        (watch_enabled, wf.watcher_debounce_seconds(), false),
    ))
}

impl Default for AutomationsCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Read-only query commands that only touch the cache live here.
/// Commands that coordinate both cache and scheduler live in `commands.rs`.
pub async fn get_automations(app: AppHandle) -> Result<Vec<Automation>, String> {
    let cache = app.state::<AutomationsCache>();
    Ok(cache.get_all_automations().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // RemoteConfig deserialization

    #[tokio::test]
    async fn late_job_binding_and_completion_cannot_revive_an_old_execution() {
        let cache = AutomationsCache::new();
        let automation = base_automation();
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();
        let started = cache
            .try_start_automation(&id, "b", None)
            .await
            .unwrap()
            .unwrap();
        let execution = started.execution_id.unwrap();
        cache.bind_job_execution("b", &execution, 7).await;
        cache
            .update_execution("b", &execution, Automation::mark_success)
            .await
            .unwrap();
        cache.bind_job_execution("b", &execution, 7).await;
        let completed = cache.get_automation(&id).await.unwrap();
        assert_eq!(completed.status, AutomationStatus::Enabled);
        assert!(completed.current_job_id.is_none());
        let next = cache
            .try_start_automation(&id, "b", None)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(next.execution_id.as_deref(), Some(execution.as_str()));
        assert!(
            cache
                .update_execution("b", &execution, Automation::mark_success)
                .await
                .is_none()
        );
        assert_eq!(cache.get_automation(&id).await.unwrap().success_count, 1);
        let mut stale = next.args.clone();
        stale.src_paths = vec!["/old".into()];
        cache
            .update_execution(
                "b",
                next.execution_id.as_deref().unwrap(),
                Automation::mark_success,
            )
            .await;
        assert!(
            cache
                .try_start_automation(&id, "b", Some(&stale))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn remote_cleanup_matches_exact_owner_and_preserves_global_definitions() {
        let cache = AutomationsCache::new();
        for (id, remote, backend, global) in [
            ("b:drive-Sync-p", "drive", "b", false),
            ("b:drive-backup-Sync-p", "drive-backup", "b", false),
            ("other:drive-Sync-p", "drive", "other", false),
            ("global", "drive", "b", true),
        ] {
            let mut automation = base_automation();
            automation.id = id.into();
            automation.remote_name = remote.into();
            automation.backend_name = backend.into();
            if global {
                automation.args.params.source = Some(crate::utils::types::origin::Origin::QuickRun);
            }
            cache.add_automation(automation).await.unwrap();
        }
        cache
            .add_or_update_automation_for_remote("b", "drive", &RemoteSettings::default())
            .await
            .unwrap();
        assert!(cache.get_automation("b:drive-Sync-p").await.is_none());
        assert_eq!(cache.get_all_automations().await.len(), 3);
        assert_eq!(
            cache
                .remove_automations_for_remote("b", "drive")
                .await
                .unwrap()
                .len(),
            0
        );
        assert_eq!(cache.get_all_automations().await.len(), 3);
    }

    fn parse_profile_config(value: &Value) -> ProfileConfig {
        ProfileConfig::parse_from_value(value).unwrap()
    }

    /// The few profile settings these tests vary, built into a real profile.
    #[derive(Default)]
    struct Profile {
        cron_enabled: Option<bool>,
        cron_expression: Option<String>,
        watch_enabled: Option<bool>,
        watch_delay: Option<u64>,
        watch_changed_only: Option<bool>,
        source: Option<Value>,
        dest: Option<Value>,
    }

    impl Profile {
        fn build(&self) -> ProfileConfig {
            let mut rclone = serde_json::Map::new();
            rclone.extend(
                self.source
                    .clone()
                    .map(|value| ("source".to_string(), value)),
            );
            rclone.extend(self.dest.clone().map(|value| ("dest".to_string(), value)));
            let mut app = serde_json::Map::new();
            for (key, value) in [
                ("cronEnabled", self.cron_enabled.map(Value::from)),
                (
                    "cronExpression",
                    self.cron_expression.clone().map(Value::from),
                ),
                ("watchEnabled", self.watch_enabled.map(Value::from)),
                ("watchDelay", self.watch_delay.map(Value::from)),
                ("watchChangedOnly", self.watch_changed_only.map(Value::from)),
            ] {
                app.extend(value.map(|value| (key.to_string(), value)));
            }
            parse_profile_config(&json!({"app": app, "rclone": rclone}))
        }
    }

    #[test]
    fn test_profile_config_deserialization() {
        let json_data = json!({
            "cronEnabled": true,
            "cronExpression": "0 0 * * *",
            "source": "/src",
            "dest": "/dst"
        });

        let p = parse_profile_config(&json_data);
        assert_eq!(p.app.cron_enabled, Some(true));
        assert_eq!(p.app.cron_expression.as_deref(), Some("0 0 * * *"));
        assert_eq!(p.source_value().and_then(|v| v.as_str()), Some("/src"));
        assert_eq!(p.dest_value().and_then(|v| v.as_str()), Some("/dst"));
    }

    #[test]
    fn test_profile_config_deserialization_aliases() {
        // Sync / Copy / Move aliases
        let json_sync = json!({
            "srcFs": "/src-sync",
            "dstFs": "/dst-sync"
        });
        let p_sync = parse_profile_config(&json_sync);
        assert_eq!(
            p_sync.source_value().and_then(|v| v.as_str()),
            Some("/src-sync")
        );
        assert_eq!(
            p_sync.dest_value().and_then(|v| v.as_str()),
            Some("/dst-sync")
        );

        // Bisync aliases
        let json_bisync = json!({
            "path1": "/src-bisync",
            "path2": "/dst-bisync"
        });
        let p_bisync = parse_profile_config(&json_bisync);
        assert_eq!(
            p_bisync.source_value().and_then(|v| v.as_str()),
            Some("/src-bisync")
        );
        assert_eq!(
            p_bisync.dest_value().and_then(|v| v.as_str()),
            Some("/dst-bisync")
        );

        // Mount / Serve aliases
        let json_mount = json!({
            "fs": "/src-mount",
            "mountPoint": "/dst-mount"
        });
        let p_mount = parse_profile_config(&json_mount);
        assert_eq!(
            p_mount.source_value().and_then(|v| v.as_str()),
            Some("/src-mount")
        );
        assert_eq!(
            p_mount.dest_value().and_then(|v| v.as_str()),
            Some("/dst-mount")
        );
    }

    // Automation ID generation

    #[test]
    fn test_generate_automation_id() {
        let id = AutomationsCache::generate_automation_id(
            "mybackend",
            "gdrive",
            &OperationType::Sync,
            "daily",
        );
        assert_eq!(id, r#"remote:["mybackend","gdrive","sync","daily"]"#);
    }

    #[test]
    fn automation_identity_cannot_collide_at_name_separators() {
        let first = AutomationsCache::generate_automation_id(
            "b",
            "drive-Sync-old",
            &OperationType::Sync,
            "new",
        );
        let second = AutomationsCache::generate_automation_id(
            "b",
            "drive",
            &OperationType::Sync,
            "old-Sync-new",
        );
        assert_ne!(first, second);
    }

    #[test]
    fn test_generate_automation_id_uniqueness_across_types() {
        let sync_id = AutomationsCache::generate_automation_id("b", "r", &OperationType::Sync, "p");
        let copy_id = AutomationsCache::generate_automation_id("b", "r", &OperationType::Copy, "p");
        assert_ne!(sync_id, copy_id);
    }

    // create_automation_struct

    fn make_cache() -> AutomationsCache {
        AutomationsCache::new()
    }

    fn make_full_profile_config(enabled: bool, cron: &str) -> Profile {
        Profile {
            cron_enabled: Some(enabled),
            cron_expression: Some(cron.to_string()),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        }
    }

    #[test]
    fn test_create_automation_struct_disabled_returns_none() {
        let cfg = make_full_profile_config(false, "* * * * *");
        let result = create_automation_struct("b", "r", "p", &OperationType::Sync, &cfg.build());
        assert!(result.is_none(), "disabled automation should return None");
    }

    #[test]
    fn test_create_automation_struct_empty_cron_returns_none() {
        let cfg = Profile {
            cron_enabled: Some(true),
            cron_expression: Some(String::new()),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        let result = create_automation_struct("b", "r", "p", &OperationType::Sync, &cfg.build());
        assert!(result.is_none(), "empty cron should return None");
    }

    #[test]
    fn test_create_automation_struct_empty_cron_but_watcher_enabled_returns_some() {
        let cfg = Profile {
            cron_enabled: Some(true),
            cron_expression: Some(String::new()),
            watch_enabled: Some(true),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        let result = create_automation_struct("b", "r", "p", &OperationType::Sync, &cfg.build());
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
        let cfg = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: None,
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        assert!(
            create_automation_struct("b", "r", "p", &OperationType::Sync, &cfg.build()).is_none(),
            "missing source should return None"
        );
    }

    #[test]
    fn test_create_automation_struct_empty_source_returns_none() {
        let cfg = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some(json!("")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        assert!(
            create_automation_struct("b", "r", "p", &OperationType::Sync, &cfg.build()).is_none(),
            "empty source should return None"
        );
    }

    #[test]
    fn test_collect_scheduled_delete_from_remote_settings() {
        let settings: RemoteSettings = serde_json::from_value(json!({
            "name": "r",
            "deleteConfigs": {
                "Cleanup": {
                    "app": { "cronEnabled": true, "cronExpression": "*/5 * * * *" },
                    "rclone": { "srcFs": ["r:trash", "r:old"] }
                }
            }
        }))
        .unwrap();
        let automations = collect_automations_from_remote("b", "r", &settings);
        assert_eq!(automations.len(), 1);
        assert_eq!(automations[0].profile_name, "Cleanup");
        assert_eq!(automations[0].automation_type, OperationType::Delete);
        assert_eq!(automations[0].args.src_paths, vec!["r:trash", "r:old"]);
        assert!(automations[0].args.dst_paths.is_empty());
    }

    #[test]
    fn test_delete_automation_requires_only_sources() {
        for source in [json!("r:trash"), json!(["r:trash", "r:old"])] {
            let cfg = Profile {
                source: Some(source.clone()),
                dest: None,
                ..make_full_profile_config(true, "*/5 * * * *")
            };
            let automation =
                create_automation_struct("b", "r", "cleanup", &OperationType::Delete, &cfg.build())
                    .expect("source-only Delete profiles must be schedulable");
            assert_eq!(automation.automation_type, OperationType::Delete);
            assert_eq!(automation.args.src_paths, normalize_paths(Some(&source)));
            assert!(automation.args.dst_paths.is_empty());
        }
        for source in [None, Some(json!("")), Some(json!([]))] {
            let cfg = Profile {
                source,
                dest: None,
                ..make_full_profile_config(true, "*/5 * * * *")
            };
            assert!(
                create_automation_struct("b", "r", "cleanup", &OperationType::Delete, &cfg.build())
                    .is_none()
            );
        }
    }

    #[test]
    fn test_create_automation_struct_missing_dest_returns_none() {
        let cfg = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some(json!("/src")),
            dest: None,
            ..Default::default()
        };
        assert!(
            create_automation_struct("b", "r", "p", &OperationType::Sync, &cfg.build()).is_none(),
            "missing dest should return None"
        );
    }

    #[test]
    fn test_create_automation_struct_empty_dest_returns_none() {
        let cfg = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some(json!("/src")),
            dest: Some(json!("")),
            ..Default::default()
        };
        assert!(
            create_automation_struct("b", "r", "p", &OperationType::Sync, &cfg.build()).is_none(),
            "empty dest should return None"
        );
    }

    #[test]
    fn test_create_automation_struct_valid() {
        let cfg = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!("/src")),
            dest: Some(json!("/dst")),
            ..Default::default()
        };
        let automation = create_automation_struct(
            "backend",
            "remote",
            "daily",
            &OperationType::Copy,
            &cfg.build(),
        )
        .expect("should produce an automation");

        assert_eq!(automation.status, AutomationStatus::Enabled);
        assert_eq!(automation.cron_expression.as_deref(), Some("*/5 * * * *"));
        assert_eq!(automation.automation_type, OperationType::Copy);
        assert!(automation.current_job_id.is_none());

        assert_eq!(automation.args.src_paths, vec!["/src".to_string()]);
        assert_eq!(automation.args.dst_paths, vec!["/dst".to_string()]);
        assert_eq!(automation.args.params.remote_name, "remote");
        assert_eq!(automation.args.params.profile_name, "daily");
    }

    #[test]
    fn test_create_automation_struct_bisync_constraints() {
        // Exactly 1 source and 1 destination is valid
        let cfg_valid = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            create_automation_struct(
                "backend",
                "remote",
                "daily",
                &OperationType::Bisync,
                &cfg_valid.build()
            )
            .is_some()
        );

        // Multiple sources is invalid for Bisync
        let cfg_multisrc = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1", "/src2"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            create_automation_struct(
                "backend",
                "remote",
                "daily",
                &OperationType::Bisync,
                &cfg_multisrc.build()
            )
            .is_none()
        );

        // Multiple destinations is invalid for Bisync
        let cfg_multidst = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1", "/dst2"])),
            ..Default::default()
        };
        assert!(
            create_automation_struct(
                "backend",
                "remote",
                "daily",
                &OperationType::Bisync,
                &cfg_multidst.build()
            )
            .is_none()
        );
    }

    #[test]
    fn test_create_automation_struct_sync_copy_move_constraints() {
        // 1 source and 1 destination is valid
        let cfg_one_to_one = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            create_automation_struct(
                "backend",
                "remote",
                "daily",
                &OperationType::Sync,
                &cfg_one_to_one.build()
            )
            .is_some()
        );

        // Multiple sources and 1 destination is valid
        let cfg_multi_to_one = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1", "/src2"])),
            dest: Some(json!(["/dst1"])),
            ..Default::default()
        };
        assert!(
            create_automation_struct(
                "backend",
                "remote",
                "daily",
                &OperationType::Sync,
                &cfg_multi_to_one.build()
            )
            .is_some()
        );

        // Multiple destinations is invalid
        let cfg_one_to_multi = Profile {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some(json!(["/src1"])),
            dest: Some(json!(["/dst1", "/dst2"])),
            ..Default::default()
        };
        assert!(
            create_automation_struct(
                "backend",
                "remote",
                "daily",
                &OperationType::Sync,
                &cfg_one_to_multi.build()
            )
            .is_none()
        );
    }

    // automation_config_changed

    fn base_automation() -> Automation {
        Automation {
            id: "b:r-sync-p".to_string(),
            automation_type: OperationType::Sync,
            remote_name: "r".to_string(),
            profile_name: "p".to_string(),
            cron_expression: Some("* * * * *".to_string()),
            status: AutomationStatus::Enabled,
            args: AutomationArgs {
                params: ProfileParams {
                    remote_name: "r".to_string(),
                    profile_name: "p".to_string(),
                    backend_name: None,
                    source: None,
                    no_cache: None,
                    scoped_targets: None,
                    execute_id: None,
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
            execution_id: None,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
            stopped_count: 0,
            watch_enabled: false,
            watch_delay: 5,
            watch_changed_only: false,
        }
    }

    #[test]
    fn test_automation_config_changed_same() {
        let a = base_automation();
        let b = base_automation();
        assert!(!automation_config_changed(&a, &b));
    }

    #[test]
    fn test_automation_config_changed_cron() {
        let a = base_automation();
        let mut b = base_automation();
        b.cron_expression = Some("0 9 * * 1-5".to_string());
        assert!(automation_config_changed(&a, &b));
    }

    #[test]
    fn test_automation_config_changed_status_ignored() {
        let a = base_automation();
        let mut b = base_automation();
        b.status = AutomationStatus::Disabled;
        assert!(!automation_config_changed(&a, &b));
    }

    // Cache CRUD

    #[tokio::test]
    async fn test_add_and_get_automation() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();

        cache.add_automation(automation.clone()).await.unwrap();
        let fetched = cache.get_automation(&id).await.unwrap();
        assert_eq!(fetched.id, id);
    }

    #[tokio::test]
    async fn concurrent_triggers_grant_exactly_one_execution_and_keep_its_backend() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.args.params.source = Some(crate::utils::types::origin::Origin::QuickRun);
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();
        let (a, b) = tokio::join!(
            cache.try_start_automation(&id, "A", None),
            cache.try_start_automation(&id, "B", None),
        );
        let granted: Vec<_> = [a.unwrap(), b.unwrap()].into_iter().flatten().collect();
        assert_eq!(granted.len(), 1);
        let cached = cache.get_automation(&id).await.unwrap();
        assert_eq!(cached.status, AutomationStatus::Running);
        assert_eq!(cached.run_count, 1);
        assert_eq!(cached.backend_name, granted[0].backend_name);
    }

    #[tokio::test]
    async fn execution_permission_rejects_inactive_disabled_stopping_and_missing_tasks() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();
        assert!(
            cache
                .try_start_automation(&id, "other", None)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(cache.get_automation(&id).await.unwrap().run_count, 0);
        cache
            .update_automation(&id, |a| a.status = AutomationStatus::Disabled)
            .await
            .unwrap();
        assert!(cache.try_start_automation(&id, "b", None).await.is_err());
        cache
            .update_automation(&id, |a| {
                a.status = AutomationStatus::Stopping;
                a.current_job_id = Some("7".into());
            })
            .await
            .unwrap();
        assert!(
            cache
                .try_start_automation(&id, "b", None)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            cache
                .get_automation(&id)
                .await
                .unwrap()
                .current_job_id
                .as_deref(),
            Some("7")
        );
        assert!(
            cache
                .try_start_automation("missing", "b", None)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_started_job_is_bound_to_its_own_execution_only() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();
        let started = cache
            .try_start_automation(&id, "b", None)
            .await
            .unwrap()
            .unwrap();
        let execution = started.execution_id.unwrap();
        assert!(
            cache
                .get_automation(&id)
                .await
                .unwrap()
                .current_job_id
                .is_none()
        );

        cache.bind_job_execution("b", "another-execution", 3).await;
        cache.bind_job_execution("other", &execution, 4).await;
        assert!(
            cache
                .get_automation(&id)
                .await
                .unwrap()
                .current_job_id
                .is_none()
        );

        cache.bind_job_execution("b", &execution, 9).await;
        assert_eq!(
            cache
                .get_automation(&id)
                .await
                .unwrap()
                .current_job_id
                .as_deref(),
            Some("9")
        );
    }

    #[tokio::test]
    async fn test_add_duplicate_automation_returns_error() {
        let cache = make_cache();
        let automation = base_automation();
        cache.add_automation(automation.clone()).await.unwrap();
        let result = cache.add_automation(automation).await;
        assert!(result.is_err(), "duplicate insert should fail");
    }

    #[tokio::test]
    async fn test_get_nonexistent_automation_returns_none() {
        let cache = make_cache();
        assert!(cache.get_automation("does-not-exist").await.is_none());
    }

    #[tokio::test]
    async fn execution_lookup_distinguishes_backend_and_completed_runs() {
        let cache = make_cache();
        for backend in ["A", "B"] {
            let mut automation = base_automation();
            automation.id = format!("{backend}:r-sync-p");
            automation.backend_name = backend.to_string();
            automation.mark_starting().unwrap();
            automation.execution_id = Some("execution".to_string());
            automation.current_job_id = Some("7".to_string());
            cache.add_automation(automation).await.unwrap();
        }
        for backend in ["A", "B"] {
            let automation = cache
                .update_execution(backend, "execution", |_| {})
                .await
                .unwrap();
            assert_eq!(automation.backend_name, backend);
        }
        assert!(
            cache
                .update_execution("missing", "execution", |_| {})
                .await
                .is_none()
        );
        assert!(cache.update_execution("A", "old", |_| {}).await.is_none());
    }

    #[tokio::test]
    async fn test_update_automation() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();

        let updated = cache
            .update_automation(&id, |t| t.run_count += 1)
            .await
            .unwrap();
        assert_eq!(updated.run_count, 1);

        let fetched = cache.get_automation(&id).await.unwrap();
        assert_eq!(fetched.run_count, 1);
    }

    #[tokio::test]
    async fn test_update_nonexistent_automation_returns_error() {
        let cache = make_cache();
        let result = cache.update_automation("ghost", |_| {}).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_automation_returns_automation() {
        let cache = make_cache();
        let automation = base_automation();
        let id = automation.id.clone();
        cache.add_automation(automation.clone()).await.unwrap();

        let removed = cache.remove_automation(&id).await.unwrap();
        assert_eq!(removed.id, id);
        assert!(
            cache.get_automation(&id).await.is_none(),
            "automation must be gone from cache"
        );
    }

    #[tokio::test]
    async fn test_remove_nonexistent_automation_returns_error() {
        let cache = make_cache();
        let result = cache.remove_automation("ghost").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_all_automations() {
        let cache = make_cache();
        let mut t1 = base_automation();
        t1.id = "id1".to_string();
        let mut t2 = base_automation();
        t2.id = "id2".to_string();

        cache.add_automation(t1).await.unwrap();
        cache.add_automation(t2).await.unwrap();

        let all = cache.get_all_automations().await;
        assert_eq!(all.len(), 2);
    }

    // clear_backend_automations

    #[tokio::test]
    async fn test_clear_backend_automations_returns_evicted() {
        let cache = make_cache();

        let mut t1 = base_automation();
        t1.id = "b1:r-sync-p".to_string();
        t1.backend_name = "b1".to_string();

        let mut t2 = base_automation();
        t2.id = "b2:r-sync-p".to_string();
        t2.backend_name = "b2".to_string();

        cache.add_automation(t1).await.unwrap();
        cache.add_automation(t2).await.unwrap();

        let evicted = cache.clear_backend_automations("b1").await;
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].backend_name, "b1");
        assert_eq!(
            cache.get_all_automations().await.len(),
            1,
            "b2 automation must remain"
        );
    }

    // toggle_automation_status

    #[tokio::test]
    async fn test_toggle_enabled_to_disabled() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Enabled;
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();

        let toggled = cache.toggle_automation_status(&id).await.unwrap();
        assert_eq!(toggled.status, AutomationStatus::Disabled);
        assert!(toggled.next_run.is_none());
    }

    #[tokio::test]
    async fn test_toggle_failed_to_disabled() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Failed;
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();

        let toggled = cache.toggle_automation_status(&id).await.unwrap();
        assert_eq!(toggled.status, AutomationStatus::Disabled);
        assert!(toggled.next_run.is_none());
    }

    #[tokio::test]
    async fn test_toggle_disabled_to_enabled() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Disabled;
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();

        let toggled = cache.toggle_automation_status(&id).await.unwrap();
        assert_eq!(toggled.status, AutomationStatus::Enabled);
    }

    #[tokio::test]
    async fn test_toggle_running_to_stopping() {
        let cache = make_cache();
        let mut automation = base_automation();
        automation.status = AutomationStatus::Running;
        let id = automation.id.clone();
        cache.add_automation(automation).await.unwrap();

        let result = cache.toggle_automation_status(&id).await.unwrap();
        assert_eq!(
            result.status,
            AutomationStatus::Stopping,
            "toggling a Running automation must transition to Stopping"
        );
    }

    // CacheUpdateResult

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

    // get_automations_for_backend / prefix filtering

    #[tokio::test]
    async fn test_get_automations_for_backend_filters_correctly() {
        let cache = make_cache();

        let mut t1 = base_automation();
        t1.id = "backend_a:remote-sync-p".to_string();
        t1.backend_name = "backend_a".to_string();

        let mut t2 = base_automation();
        t2.id = "backend_b:remote-sync-p".to_string();
        t2.backend_name = "backend_b".to_string();

        cache.add_automation(t1).await.unwrap();
        cache.add_automation(t2).await.unwrap();

        let a_automations = cache.get_automations_for_backend("backend_a").await;
        assert_eq!(a_automations.len(), 1);
        assert_eq!(a_automations[0].backend_name, "backend_a");
    }

    #[tokio::test]
    async fn deleting_global_definitions_after_switch_removes_their_automations() {
        let cache = make_cache();
        for (id, source) in [
            ("quick", crate::utils::types::origin::Origin::QuickRun),
            ("flow", crate::utils::types::origin::Origin::Workflow),
        ] {
            let mut automation = base_automation();
            automation.id = id.to_string();
            automation.backend_name = "A".to_string();
            automation.args.params.source = Some(source);
            cache.add_automation(automation).await.unwrap();
        }
        assert!(cache.clear_backend_automations("A").await.is_empty());
        assert_eq!(
            cache
                .load_from_quick_runs(&[], "B")
                .await
                .unwrap()
                .removed
                .len(),
            1
        );
        assert!(cache.get_automation("flow").await.is_some());
        assert_eq!(
            cache
                .load_from_workflows(&[], "B")
                .await
                .unwrap()
                .removed
                .len(),
            1
        );
        assert!(cache.get_all_automations().await.is_empty());
    }

    #[test]
    fn test_collect_automations_from_remote() {
        let remote_settings_val = json!({
            "syncConfigs": {
                "watcher_profile": {
                    "app": {
                        "watchEnabled": true,
                        "watchDelay": 5
                    },
                    "rclone": {
                        "srcFs": "/local/src",
                        "dstFs": "remote:/dst"
                    }
                }
            },
            "copyConfigs": {
                "scheduled_profile": {
                    "app": {
                        "cronEnabled": true,
                        "cronExpression": "0 12 * * *"
                    },
                    "rclone": {
                        "srcFs": "/local/backup",
                        "dstFs": "remote:/backup"
                    }
                }
            }
        });
        let remote_settings: RemoteSettings =
            serde_json::from_value(remote_settings_val).expect("valid RemoteSettings");

        let automations = collect_automations_from_remote("local", "gdrive", &remote_settings);
        assert_eq!(automations.len(), 2);

        let watcher = automations
            .iter()
            .find(|a| a.profile_name == "watcher_profile")
            .expect("watcher automation found");
        assert_eq!(watcher.automation_type, OperationType::Sync);
        assert!(watcher.watch_enabled);

        let scheduled = automations
            .iter()
            .find(|a| a.profile_name == "scheduled_profile")
            .expect("scheduled automation found");
        assert_eq!(scheduled.automation_type, OperationType::Copy);
        assert_eq!(scheduled.cron_expression.as_deref(), Some("0 12 * * *"));
    }

    #[tokio::test]
    async fn test_create_and_load_workflow_automations() {
        let cache = make_cache();

        let wf_with_cron = WorkflowDefinition {
            id: "wf-cron-1".to_string(),
            name: "Nightly Sync Flow".to_string(),
            nodes: vec![crate::services::flow::workflow::types::WorkflowNode {
                id: "node-c".to_string(),
                node_type: "cron".to_string(),
                category: crate::services::flow::workflow::types::WorkflowNodeCategory::Trigger,
                title: "Cron".to_string(),
                config: serde_json::json!({
                    "cronExpression": "0 3 * * *"
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        let wf_without_cron = WorkflowDefinition {
            id: "wf-manual-1".to_string(),
            name: "Manual Flow".to_string(),
            ..Default::default()
        };

        let wf_with_watcher = WorkflowDefinition {
            id: "wf-watcher-1".to_string(),
            name: "Watcher Flow".to_string(),
            nodes: vec![crate::services::flow::workflow::types::WorkflowNode {
                id: "node-w".to_string(),
                node_type: "watcher".to_string(),
                category: crate::services::flow::workflow::types::WorkflowNodeCategory::Trigger,
                title: "Watcher".to_string(),
                config: serde_json::json!({
                    "watchPaths": ["/tmp/sync_dir"],
                    "debounceSeconds": 8
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        let auto1 = create_automation_from_workflow("local", &wf_with_cron);
        assert!(auto1.is_some());
        let a1 = auto1.unwrap();
        assert_eq!(a1.id, "wf-cron-1");
        assert_eq!(a1.cron_expression.as_deref(), Some("0 3 * * *"));
        assert!(!a1.watch_enabled);
        assert_eq!(
            a1.args.params.source,
            Some(crate::utils::types::origin::Origin::Workflow)
        );

        let auto2 = create_automation_from_workflow("local", &wf_without_cron);
        assert!(auto2.is_none());

        let auto3 = create_automation_from_workflow("local", &wf_with_watcher);
        assert!(auto3.is_some());
        let a3 = auto3.unwrap();
        assert_eq!(a3.id, "wf-watcher-1");
        assert!(a3.cron_expression.is_none());
        assert!(a3.watch_enabled);
        assert_eq!(a3.watch_delay, 8);
        assert_eq!(a3.args.src_paths, vec!["/tmp/sync_dir".to_string()]);

        let res = cache
            .load_from_workflows(&[wf_with_cron, wf_without_cron, wf_with_watcher], "local")
            .await
            .expect("load_from_workflows succeeds");
        assert_eq!(res.added.len(), 2);

        let loaded = cache.get_automation("wf-watcher-1").await;
        assert!(loaded.is_some());
        assert!(loaded.unwrap().watch_enabled);
    }

    #[tokio::test]
    async fn test_load_from_remote_configs_preserves_quickrun_and_flow_automations() {
        let cache = make_cache();

        // 1. Load a workflow automation
        let wf = WorkflowDefinition {
            id: "wf-preserve".to_string(),
            name: "Preserve Me".to_string(),
            nodes: vec![crate::services::flow::workflow::types::WorkflowNode {
                id: "node-c-preserve".to_string(),
                node_type: "cron".to_string(),
                category: crate::services::flow::workflow::types::WorkflowNodeCategory::Trigger,
                title: "Cron".to_string(),
                config: serde_json::json!({
                    "cronExpression": "0 1 * * *"
                }),
                ..Default::default()
            }],
            ..Default::default()
        };
        cache
            .load_from_workflows(&[wf], "local")
            .await
            .expect("load_from_workflows");

        // 2. Load a quick run automation
        let qr = QuickRun {
            id: "qr-preserve".to_string(),
            name: "QR Preserve".to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config: serde_json::json!({
                "app": {
                    "cronEnabled": true,
                    "cronExpression": "0 2 * * *"
                },
                "rclone": {
                    "srcFs": "drive:src",
                    "dstFs": "/tmp/dst"
                }
            }),
        };
        cache
            .load_from_quick_runs(&[qr], "local")
            .await
            .expect("load_from_quick_runs");

        assert!(cache.get_automation("wf-preserve").await.is_some());
        assert!(cache.get_automation("qr-preserve").await.is_some());

        // 3. Now trigger load_from_remote_configs with an empty remote map
        let empty_remotes = HashMap::new();
        let res = cache
            .load_from_remote_configs(&empty_remotes, "local")
            .await
            .expect("load_from_remote_configs");

        // Should not remove either the workflow or quick run automation!
        assert_eq!(res.removed.len(), 0);
        assert!(cache.get_automation("wf-preserve").await.is_some());
        assert!(cache.get_automation("qr-preserve").await.is_some());
    }

    #[tokio::test]
    async fn a_sync_changes_the_cache_under_one_lock_and_announces_it_once() {
        let cache = make_cache();
        let mut stale = base_automation();
        stale.id = "stale".into();
        let mut kept = base_automation();
        kept.id = "kept".into();
        kept.status = AutomationStatus::Disabled;
        cache.add_automation(stale).await.unwrap();
        cache.add_automation(kept.clone()).await.unwrap();

        let mut changed = kept.clone();
        changed.cron_expression = Some("0 5 * * *".into());
        changed.status = AutomationStatus::Enabled;
        let mut fresh = base_automation();
        fresh.id = "fresh".into();
        let result = cache
            .sync_automations(vec![changed, fresh], |_| true)
            .await
            .unwrap();

        assert_eq!(result.added.len(), 1);
        assert_eq!(result.updated.len(), 1);
        assert_eq!(result.removed.len(), 1);
        assert_eq!(result.removed[0].id, "stale");
        // The new configuration is taken, the user's enabled/disabled choice stays.
        let kept = cache.get_automation("kept").await.unwrap();
        assert_eq!(kept.cron_expression.as_deref(), Some("0 5 * * *"));
        assert_eq!(kept.status, AutomationStatus::Disabled);
        assert!(cache.get_automation("stale").await.is_none());
        // Nothing changes the second time.
        let again = cache
            .sync_automations(cache.get_all_automations().await, |_| true)
            .await
            .unwrap();
        assert!(!again.has_changes());
    }

    #[test]
    fn quick_run_paths_come_from_the_canonical_setting_names() {
        let quick_run = |rclone: Value| QuickRun {
            id: "qr".into(),
            name: "QR".into(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "drive:".into(),
            config: json!({"app": {"watchEnabled": true}, "rclone": rclone}),
        };
        let automation = create_automation_from_quick_run(
            "b",
            &quick_run(json!({"path1": "/a", "mountPoint": "/m"})),
        )
        .unwrap();
        assert_eq!(automation.args.src_paths, vec!["/a"]);
        assert_eq!(automation.args.dst_paths, vec!["/m"]);
        // Blank values are skipped; with no source the remote itself is watched.
        let automation =
            create_automation_from_quick_run("b", &quick_run(json!({"source": "  ", "dest": ""})))
                .unwrap();
        assert_eq!(automation.args.src_paths, vec!["drive:"]);
        assert!(automation.args.dst_paths.is_empty());
    }

    #[test]
    fn a_new_automation_is_enabled_unscheduled_and_named_after_its_arguments() {
        let automation = base_automation();
        let created = Automation::new(
            "id".into(),
            OperationType::Sync,
            automation.args.clone(),
            "backend",
        );
        assert_eq!(created.remote_name, automation.args.params.remote_name);
        assert_eq!(created.profile_name, automation.args.params.profile_name);
        assert_eq!(created.backend_name, "backend");
        assert_eq!(created.status, AutomationStatus::Enabled);
        assert!(created.cron_expression.is_none() && !created.watch_enabled);
        assert_eq!(created.watch_delay, DEFAULT_WATCH_DELAY);
    }
}
