//! Only enabled background tasks retain their execution inputs across vault locks.
//! Running workflows own their own snapshots, which are dropped on completion.

use crate::rclone::backend::BackendManager;
use crate::utils::{
    json_helpers::{DEFAULT_PROFILE_NAME, find_profile, interpolate_shell_commands},
    types::remotes::{OperationType, ProfileConfig, helper_config_keys},
};
use crate::{
    context::AppHandle,
    rclone::{
        backend::types::Backend,
        commands::common::{ResolvedProfile, parse_profile_config},
    },
    services::{
        flow::{
            quick_run::{commands::get_quick_run, types::QuickRun},
            workflow::{
                commands::get_workflow_by_id,
                types::{NodeKind, WorkflowDefinition},
            },
        },
        settings::AppSettingsManager,
    },
    utils::types::{automation::AutomationStatus, origin::Origin},
};
use parking_lot::RwLock;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

/// Only the selected task profile and the helper profiles it references.
#[derive(Clone)]
struct ProfileSnapshot {
    pub backend: Backend,
    profile: ProfileConfig,
    options: Value,
    name: String,
}

impl ProfileSnapshot {
    fn resolve(&self) -> Result<ResolvedProfile, String> {
        Ok(ResolvedProfile {
            backend: self.backend.clone(),
            params: parse_profile_config(&self.profile, &self.options, Some(self.name.clone()))?,
        })
    }
}

async fn capture_profile_settings(
    app: &AppHandle,
    remote_name: &str,
    profile_name: &str,
    operation: OperationType,
    expected_backend: Option<&str>,
) -> Result<ProfileSnapshot, String> {
    let manager = app.state::<AppSettingsManager>();
    let (backend, settings) = app
        .state::<BackendManager>()
        .active_remote_settings(manager.inner(), remote_name, expected_backend)
        .await?;
    let mut profile = settings
        .get_configs(operation)
        .and_then(|profiles| profiles.get(profile_name))
        .cloned()
        .ok_or_else(|| {
            format!(
                "{} profile '{profile_name}' for '{remote_name}' not found",
                operation.config_key()
            )
        })?;
    let mut options = json!({"name": remote_name});
    for (reference, section, values) in [
        (
            &mut profile.app.vfs_profile,
            helper_config_keys::VFS,
            settings.vfs_configs.as_ref(),
        ),
        (
            &mut profile.app.filter_profile,
            helper_config_keys::FILTER,
            settings.filter_configs.as_ref(),
        ),
        (
            &mut profile.app.backend_profile,
            helper_config_keys::BACKEND,
            settings.backend_configs.as_ref(),
        ),
        (
            &mut profile.app.runtime_remote_profile,
            helper_config_keys::RUNTIME_REMOTE,
            settings.runtime_remote_configs.as_ref(),
        ),
    ] {
        if let Some(name) = reference {
            *name = interpolate_shell_commands(name).into_owned();
        }
        let name = reference.as_deref().unwrap_or(DEFAULT_PROFILE_NAME);
        if let Some(value) = values.and_then(|values| find_profile(values, name)) {
            options[section] = json!({name: value});
        }
    }
    Ok(ProfileSnapshot {
        backend,
        profile,
        options,
        name: profile_name.to_owned(),
    })
}

/// Dependencies belong to this execution, including nodes after a timer/wait.
#[derive(Clone)]
pub struct WorkflowSnapshot {
    pub definition: WorkflowDefinition,
    pub quick_runs: HashMap<String, QuickRun>,
    pub quick_run_names: HashMap<String, String>,
}

impl WorkflowSnapshot {
    pub fn capture(
        manager: &AppSettingsManager,
        definition: WorkflowDefinition,
    ) -> Result<Self, String> {
        // Quick Runs belong to the selected backend, which can change while the
        // workflow runs, so the ones it names are read now rather than per node.
        let mut presets = HashMap::new();
        for node in &definition.nodes {
            if node.kind() == NodeKind::QuickRun
                && let Some(id) = node.config.get("quickRunId").and_then(Value::as_str)
                && !id.contains("{{")
                && !presets.contains_key(id.trim())
                && let Some(preset) = get_quick_run(manager, id.trim())?
            {
                presets.insert(preset.id.clone(), preset);
            }
        }
        Ok(Self {
            definition,
            quick_runs: presets,
            quick_run_names: HashMap::new(),
        })
    }

    fn from_presets(definition: WorkflowDefinition, presets: &HashMap<String, QuickRun>) -> Self {
        let mut quick_runs = HashMap::new();
        for node in &definition.nodes {
            if node.kind() == NodeKind::QuickRun
                && let Some(id) = node.config.get("quickRunId").and_then(Value::as_str)
                && let Some(preset) = presets.get(id.trim())
            {
                quick_runs.insert(preset.id.clone(), preset.clone());
            }
        }
        let targets: HashSet<_> = definition
            .nodes
            .iter()
            .filter(|node| node.kind() == NodeKind::JobEvent)
            .filter_map(|node| node.config.get("targetProfileId").and_then(Value::as_str))
            .map(|target| target.trim().to_lowercase())
            .collect();
        let quick_run_names = presets
            .values()
            .filter(|preset| {
                targets.contains(&preset.id.to_lowercase())
                    || targets.contains(&preset.name.to_lowercase())
            })
            .map(|preset| (preset.id.clone(), preset.name.clone()))
            .collect();
        Self {
            definition,
            quick_runs,
            quick_run_names,
        }
    }
}

#[derive(Default)]
struct TaskSnapshots {
    revision: u64,
    profiles: HashMap<String, ProfileSnapshot>,
    quick_runs: HashMap<String, QuickRun>,
    workflows: HashMap<String, Arc<WorkflowSnapshot>>,
}

#[derive(Default)]
pub struct RuntimeTasks {
    tasks: RwLock<TaskSnapshots>,
    refresh_lock: tokio::sync::Mutex<()>,
    completed_workflows: RwLock<HashMap<String, String>>,
    /// Stored workflows with a `job_event` trigger, so a finishing job need not
    /// read every workflow from storage. Dropped whenever definitions change.
    event_triggers: RwLock<Option<Arc<Vec<WorkflowDefinition>>>>,
}

impl RuntimeTasks {
    pub(crate) fn revision(&self) -> u64 {
        self.tasks.read().revision
    }

    fn profile(&self, id: &str) -> Option<ProfileSnapshot> {
        self.tasks.read().profiles.get(id).cloned()
    }
    pub fn quick_run(&self, id: &str) -> Option<QuickRun> {
        self.tasks.read().quick_runs.get(id).cloned()
    }
    pub fn workflow(&self, id: &str) -> Option<Arc<WorkflowSnapshot>> {
        self.tasks.read().workflows.get(id).cloned()
    }
    pub fn event_workflows(&self) -> Vec<Arc<WorkflowSnapshot>> {
        self.tasks
            .read()
            .workflows
            .values()
            .filter(|wf| wf.definition.has_job_event_trigger())
            .cloned()
            .collect()
    }

    /// Workflows with a `job_event` trigger, loaded through `load` on first use
    /// and kept until definitions change. A failed load is not remembered.
    pub fn event_triggers(
        &self,
        load: impl FnOnce() -> Result<Vec<WorkflowDefinition>, String>,
    ) -> Result<Arc<Vec<WorkflowDefinition>>, String> {
        if let Some(cached) = self.event_triggers.read().as_ref() {
            return Ok(cached.clone());
        }
        let revision = self.revision();
        let triggers: Arc<Vec<WorkflowDefinition>> = Arc::new(
            load()?
                .into_iter()
                .filter(WorkflowDefinition::has_job_event_trigger)
                .collect(),
        );
        // Definitions edited while loading make this list stale; use it once, don't keep it.
        // The check and the store share one lock, so an invalidation either comes
        // first (revision differs) or clears what is stored here.
        let mut cached = self.event_triggers.write();
        if self.revision() == revision {
            *cached = Some(triggers.clone());
        }
        drop(cached);
        Ok(triggers)
    }

    pub fn record_completion(&self, id: &str, timestamp: String) {
        self.completed_workflows
            .write()
            .insert(id.to_owned(), timestamp);
    }

    fn invalidate(&self, update: impl FnOnce(&mut TaskSnapshots)) {
        let mut tasks = self.tasks.write();
        let revision = tasks.revision.wrapping_add(1);
        update(&mut tasks);
        tasks.revision = revision;
        drop(tasks);
        // After the revision moved: a loader that read the old one no longer stores its list.
        // Never taken while `tasks` is held, as loaders take `tasks` while holding this lock.
        *self.event_triggers.write() = None;
    }

    pub fn invalidate_workflow(&self, id: &str) {
        self.invalidate(|tasks| {
            tasks.workflows.remove(id);
        });
    }

    pub fn invalidate_quick_run(&self, id: &str) {
        self.invalidate(|tasks| {
            tasks.quick_runs.remove(id);
            tasks.workflows.retain(|_, workflow| {
                !workflow.quick_runs.contains_key(id) && !workflow.quick_run_names.contains_key(id)
            });
        });
    }

    pub fn invalidate_remote(&self, remote: &str) {
        self.invalidate(|tasks| {
            tasks.profiles.retain(|_, profile| {
                profile.options.get("name").and_then(Value::as_str) != Some(remote)
            });
        });
    }

    pub fn invalidate_all(&self) {
        self.invalidate(|tasks| *tasks = TaskSnapshots::default());
    }

    /// Write only completion metadata; keep definitions edited since execution.
    pub fn flush_completions(&self, manager: &AppSettingsManager) -> Result<(), String> {
        let mut pending = self.completed_workflows.write();
        if pending.is_empty() {
            return Ok(());
        }
        // A workflow deleted since it ran is simply not recorded.
        for (id, timestamp) in pending.iter() {
            crate::services::flow::workflow::commands::record_last_executed(
                manager, id, timestamp,
            )?;
        }
        pending.clear();
        Ok(())
    }
}

/// Replacing this set drops disabled/deleted tasks and unrelated profile data.
pub async fn refresh(app: &AppHandle) -> Result<(), String> {
    refresh_with_definitions(app, None, None, None).await
}

/// Reuse definitions already read by the automation loader instead of reading them twice.
pub(crate) async fn refresh_with_definitions(
    app: &AppHandle,
    prepared_revision: Option<u64>,
    quick_runs: Option<Vec<QuickRun>>,
    workflows: Option<Vec<WorkflowDefinition>>,
) -> Result<(), String> {
    let Some(runtime) = app.try_state::<RuntimeTasks>() else {
        return Ok(());
    };
    let manager = app.state::<AppSettingsManager>();
    if !manager.is_vault_enabled() {
        runtime.invalidate_all();
        return Ok(());
    }
    let _refresh = runtime.refresh_lock.lock().await;
    if manager.is_locked() {
        return Ok(());
    }
    // Mutations invalidate their own inputs. Preserve other prepared tasks if
    // storage locks or a rebuild is cancelled before the replacement is ready.
    let revision = prepared_revision.unwrap_or_else(|| runtime.revision());
    let backend = app
        .state::<crate::rclone::backend::BackendManager>()
        .get_active()
        .await;
    let automations = app
        .state::<crate::rclone::state::automations::AutomationsCache>()
        .get_all_automations()
        .await;
    let workflows = match workflows {
        Some(workflows) => workflows,
        None => crate::services::flow::workflow::commands::get_all_workflows_sync(&manager)?,
    };
    let quick_runs = match quick_runs {
        Some(quick_runs) => quick_runs,
        None => crate::services::flow::quick_run::commands::get_all_quick_runs_sync(&manager)?,
    };
    let workflows: HashMap<_, _> = workflows
        .into_iter()
        .map(|workflow| (workflow.id.clone(), workflow))
        .collect();
    let presets: HashMap<_, _> = quick_runs
        .into_iter()
        .map(|preset| (preset.id.clone(), preset))
        .collect();
    let mut tasks = TaskSnapshots::default();
    for automation in automations.into_iter().filter(|a| {
        a.belongs_to_backend(&backend.name)
            && !matches!(
                a.status,
                AutomationStatus::Disabled | AutomationStatus::Stopping
            )
    }) {
        let captured = async {
            match automation.args.params.source {
                Some(Origin::QuickRun) => {
                    if let Some(qr) = presets.get(&automation.id) {
                        tasks.quick_runs.insert(qr.id.clone(), qr.clone());
                    }
                }
                Some(Origin::Flow) => {
                    if let Some(wf) = workflows.get(&automation.id) {
                        tasks.workflows.insert(
                            wf.id.clone(),
                            Arc::new(WorkflowSnapshot::from_presets(wf.clone(), &presets)),
                        );
                    }
                }
                _ => {
                    let snapshot = capture_profile_settings(
                        app,
                        &automation.remote_name,
                        &automation.profile_name,
                        automation.automation_type,
                        Some(&backend.name),
                    )
                    .await?;
                    tasks.profiles.insert(automation.id.clone(), snapshot);
                }
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = captured {
            log::warn!(
                "Skipping unavailable runtime task '{}': {error}",
                automation.id
            );
        }
    }
    // Job-event workflows have no cron entry, but are also background tasks.
    for wf in workflows.into_values() {
        if wf.has_job_event_trigger() && !tasks.workflows.contains_key(&wf.id) {
            tasks.workflows.insert(
                wf.id.clone(),
                Arc::new(WorkflowSnapshot::from_presets(wf, &presets)),
            );
        }
    }
    if manager.is_locked() {
        return Err(crate::services::settings::access::locked_error());
    }
    if !manager.is_vault_enabled() {
        return Ok(());
    }
    let mut current = runtime.tasks.write();
    if current.revision != revision {
        return Err(
            crate::localized_error!("backendErrors.vault.operationFailed", "error" => "Task configuration changed during snapshot preparation"),
        );
    }
    tasks.revision = revision.wrapping_add(1);
    *current = tasks;
    drop(current);
    *runtime.event_triggers.write() = None;
    Ok(())
}

pub async fn flush_completions(app: &AppHandle) -> Result<(), String> {
    let app = app.clone();
    crate::utils::spawn_blocking(move || {
        app.state::<RuntimeTasks>()
            .flush_completions(app.state::<AppSettingsManager>().inner())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn capture_workflow(
    manager: &AppSettingsManager,
    id: &str,
) -> Result<Arc<WorkflowSnapshot>, String> {
    let definition =
        get_workflow_by_id(manager, id)?.ok_or_else(|| format!("Workflow '{id}' not found"))?;
    Ok(Arc::new(WorkflowSnapshot::capture(manager, definition)?))
}

pub fn workflow(app: &AppHandle, id: &str) -> Result<Arc<WorkflowSnapshot>, String> {
    let manager = app.state::<AppSettingsManager>();
    if !manager.is_locked() {
        let captured = capture_workflow(&manager, id);
        if !manager.is_locked() {
            return captured;
        }
    }
    app.try_state::<RuntimeTasks>()
        .and_then(|runtime| runtime.workflow(id))
        .ok_or_else(crate::services::settings::access::locked_error)
}

pub fn quick_run(app: &AppHandle, id: &str) -> Result<QuickRun, String> {
    let manager = app.state::<AppSettingsManager>();
    if !manager.is_locked() {
        let captured = get_quick_run(&manager, id)
            .and_then(|qr| qr.ok_or_else(|| format!("Quick run '{id}' not found")));
        if captured.is_ok() || !manager.is_locked() {
            return captured;
        }
    }
    app.try_state::<RuntimeTasks>()
        .and_then(|runtime| runtime.quick_run(id))
        .ok_or_else(crate::services::settings::access::locked_error)
}

pub fn profile(
    app: &AppHandle,
    id: &str,
    backend: &Backend,
) -> Result<crate::rclone::commands::common::ResolvedProfile, String> {
    let runtime = app
        .try_state::<RuntimeTasks>()
        .ok_or_else(crate::services::settings::access::locked_error)?;
    let snapshot = runtime
        .profile(id)
        .filter(|snapshot| snapshot.backend.name == backend.name)
        .ok_or_else(crate::services::settings::access::locked_error)?;
    snapshot.resolve()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        rclone::state::automations::AutomationsCache,
        services::{flow::workflow::types::WorkflowNode, settings::access::tests::app},
        utils::{
            constants::{SUB_QUICK_RUNS, SUB_WORKFLOWS},
            types::remotes::RemoteSettings,
        },
    };
    use serde_json::json;

    fn store_workflow(
        app: &AppHandle,
        id: &str,
        node_type: &str,
        config: serde_json::Value,
    ) -> WorkflowDefinition {
        let workflow = WorkflowDefinition {
            id: id.into(),
            name: id.into(),
            nodes: vec![WorkflowNode {
                id: "trigger".into(),
                node_type: node_type.into(),
                config,
                ..Default::default()
            }],
            ..Default::default()
        };
        app.state::<AppSettingsManager>()
            .sub_settings(SUB_WORKFLOWS)
            .unwrap()
            .set(id, &workflow)
            .unwrap();
        workflow
    }

    #[tokio::test]
    async fn definitions_read_before_an_invalidation_cannot_replace_prepared_tasks() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        let workflow = store_workflow(
            &app,
            "stale",
            "job_event",
            json!({"targetProfileId": "drive"}),
        );
        refresh(&app).await.unwrap();
        let runtime = app.state::<RuntimeTasks>();
        let revision = runtime.revision();
        runtime.invalidate_workflow(&workflow.id);
        let result =
            refresh_with_definitions(&app, Some(revision), Some(Vec::new()), Some(vec![workflow]))
                .await;
        assert!(result.is_err());
        assert!(runtime.workflow("stale").is_none());
    }

    #[tokio::test]
    async fn only_enabled_task_inputs_survive_the_real_vault_lock() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        let settings: RemoteSettings = serde_json::from_value(json!({
            "syncConfigs": {
                "Scheduled": {"app": {"cronEnabled": true, "cronExpression": "0 3 * * *", "vfsProfile": "needed"}, "rclone": {"srcFs": "/src", "dstFs": "/dst"}},
                "Manual": {"app": {}, "rclone": {"srcFs": "/private", "dstFs": "/unused"}}
            },
            "vfsConfigs": {"needed": {"CacheMode": "full"}, "unused": {"CacheMode": "off"}}
        })).unwrap();
        let manager = app.state::<AppSettingsManager>();
        manager
            .sub_settings("remotes")
            .unwrap()
            .set("drive", &settings)
            .unwrap();
        let cache = app.state::<AutomationsCache>();
        let result = cache
            .load_from_remote_configs(&HashMap::from([("drive".into(), settings)]), "Local")
            .await
            .unwrap();
        let id = result.added[0].id.clone();
        let scheduled = store_workflow(
            &app,
            "scheduled",
            "cron",
            json!({"cronExpression": "0 3 * * *"}),
        );
        store_workflow(&app, "manual", "manual", json!({}));
        cache
            .load_from_workflows(&[scheduled], "Local")
            .await
            .unwrap();
        let qr: QuickRun = serde_json::from_value(json!({"id": "qr-private", "name": "Private preset", "remoteName": "drive", "operationType": "copy", "config": {"source": "/secret", "dest": "/unused"}})).unwrap();
        manager
            .sub_settings(SUB_QUICK_RUNS)
            .unwrap()
            .set(&qr.id, &qr)
            .unwrap();
        refresh(&app).await.unwrap();
        manager.lock().unwrap();
        assert!(manager.get_all().is_err());
        assert!(
            manager
                .sub_settings("remotes")
                .unwrap()
                .get::<RemoteSettings>("drive")
                .is_err()
        );
        let backend = app
            .state::<crate::rclone::backend::BackendManager>()
            .get_active()
            .await;
        let params = profile(&app, &id, &backend).unwrap().params;
        assert_eq!(params.source, ["/src"]);
        assert_eq!(params.vfs_options.unwrap()["CacheMode"], "full");
        assert!(workflow(&app, "scheduled").is_ok());
        assert!(workflow(&app, "manual").is_err());
        assert!(quick_run(&app, &qr.id).is_err());
        let runtime = app.state::<RuntimeTasks>();
        assert_eq!(runtime.tasks.read().profiles.len(), 1);
        assert!(runtime.tasks.read().quick_runs.is_empty());
        assert_eq!(runtime.tasks.read().workflows.len(), 1);
        let before = cache.get_all_automations().await.len();
        assert_eq!(
            super::super::commands::reload_automations_from_configs(&app)
                .await
                .unwrap(),
            before
        );
        assert_eq!(cache.get_all_automations().await.len(), before);
    }

    #[tokio::test]
    async fn disabled_tasks_are_removed_and_running_executions_keep_their_own_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        let workflow = store_workflow(
            &app,
            "scheduled",
            "cron",
            json!({"cronExpression": "0 3 * * *"}),
        );
        let cache = app.state::<AutomationsCache>();
        cache
            .load_from_workflows(&[workflow], "Local")
            .await
            .unwrap();
        refresh(&app).await.unwrap();
        let captured = app.state::<RuntimeTasks>().workflow("scheduled").unwrap();
        cache
            .update_automation("scheduled", |a| a.status = AutomationStatus::Disabled)
            .await
            .unwrap();
        refresh(&app).await.unwrap();
        assert!(app.state::<RuntimeTasks>().workflow("scheduled").is_none());
        assert_eq!(captured.definition.id, "scheduled");
        app.state::<AppSettingsManager>().lock().unwrap();
        assert!(super::workflow(&app, "scheduled").is_err());
    }

    #[tokio::test]
    async fn disabling_vault_clears_task_snapshots_and_skips_workflow_dependency_capture() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        let workflow = store_workflow(
            &app,
            "scheduled",
            "cron",
            json!({"cronExpression": "0 3 * * *"}),
        );
        app.state::<AutomationsCache>()
            .load_from_workflows(std::slice::from_ref(&workflow), "Local")
            .await
            .unwrap();
        refresh(&app).await.unwrap();
        assert!(app.state::<RuntimeTasks>().workflow("scheduled").is_some());
        app.state::<AppSettingsManager>()
            .disable_vault("password")
            .unwrap();
        refresh(&app).await.unwrap();
        assert!(
            app.state::<RuntimeTasks>()
                .tasks
                .read()
                .workflows
                .is_empty()
        );
        let mut workflow = workflow;
        workflow.nodes.push(WorkflowNode {
            node_type: "quick_run".into(),
            config: json!({"quickRunId": "missing"}),
            ..Default::default()
        });
        let snapshot =
            WorkflowSnapshot::capture(app.state::<AppSettingsManager>().inner(), workflow).unwrap();
        assert!(snapshot.quick_runs.is_empty());
    }

    #[tokio::test]
    async fn a_failed_task_refresh_removes_its_old_inputs_without_disabling_other_tasks() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        let mut settings: RemoteSettings = serde_json::from_value(json!({"syncConfigs": {
            "A": {"app": {"cronEnabled": true, "cronExpression": "0 3 * * *"}, "rclone": {"srcFs": "/a", "dstFs": "/dst"}},
            "B": {"app": {"cronEnabled": true, "cronExpression": "0 3 * * *"}, "rclone": {"srcFs": "/b", "dstFs": "/dst"}}
        }})).unwrap();
        let manager = app.state::<AppSettingsManager>();
        let sub = manager.sub_settings("remotes").unwrap();
        sub.set("drive", &settings).unwrap();
        let result = app
            .state::<AutomationsCache>()
            .load_from_remote_configs(
                &HashMap::from([("drive".into(), settings.clone())]),
                "Local",
            )
            .await
            .unwrap();
        let a = result
            .added
            .iter()
            .find(|a| a.profile_name == "A")
            .unwrap()
            .id
            .clone();
        let b = result
            .added
            .iter()
            .find(|a| a.profile_name == "B")
            .unwrap()
            .id
            .clone();
        refresh(&app).await.unwrap();
        assert!(app.state::<RuntimeTasks>().profile(&a).is_some());
        // Simulate an external settings change before the automation cache catches up.
        settings.sync_configs.as_mut().unwrap().remove("A");
        sub.set("drive", &settings).unwrap();
        refresh(&app).await.unwrap();
        assert!(app.state::<RuntimeTasks>().profile(&a).is_none());
        assert!(app.state::<RuntimeTasks>().profile(&b).is_some());
        manager.lock().unwrap();
        let backend = app.state::<BackendManager>().get_active().await;
        assert!(profile(&app, &a, &backend).is_err());
        assert_eq!(profile(&app, &b, &backend).unwrap().params.source, ["/b"]);
    }

    #[tokio::test]
    async fn an_existing_file_watcher_executes_its_workflow_after_the_vault_locks() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        let workflow = store_workflow(
            &app,
            "watcher",
            "watcher",
            json!({"watchPaths": [directory.path().to_str().unwrap()], "globPattern": "*.txt", "debounceSeconds": 1}),
        );
        app.state::<AutomationsCache>()
            .load_from_workflows(&[workflow], "Local")
            .await
            .unwrap();
        refresh(&app).await.unwrap();
        let watcher = crate::services::automation::watcher::WatcherManager::new();
        watcher.sync_watchers(app.clone()).await.unwrap();
        app.state::<AppSettingsManager>().lock().unwrap();
        tokio::fs::write(directory.path().join("watched.txt"), "changed")
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if app
                    .state::<RuntimeTasks>()
                    .completed_workflows
                    .read()
                    .contains_key("watcher")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(app.state::<AppSettingsManager>().get_all().is_err());
    }

    #[tokio::test]
    async fn completion_metadata_waits_for_unlock_and_preserves_edited_or_deleted_definitions() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        let mut workflow = store_workflow(&app, "manual", "manual", json!({}));
        let manager = app.state::<AppSettingsManager>();
        let runtime = app.state::<RuntimeTasks>();
        runtime.record_completion(&workflow.id, "2026-10-21T00:00:00Z".into());
        manager.lock().unwrap();
        assert!(runtime.flush_completions(&manager).is_err());
        assert_eq!(runtime.completed_workflows.read().len(), 1);
        manager.unlock("password").unwrap();
        workflow.name = "Edited while execution was running".into();
        let sub = manager.sub_settings(SUB_WORKFLOWS).unwrap();
        sub.set(&workflow.id, &workflow).unwrap();
        runtime.flush_completions(&manager).unwrap();
        let saved: WorkflowDefinition = sub.get(&workflow.id).unwrap();
        assert_eq!(saved.name, workflow.name);
        assert_eq!(
            saved.last_executed_at.as_deref(),
            Some("2026-10-21T00:00:00Z")
        );
        runtime.record_completion(&workflow.id, "later".into());
        sub.delete(&workflow.id).unwrap();
        runtime.flush_completions(&manager).unwrap();
        assert!(sub.get::<WorkflowDefinition>(&workflow.id).is_err());
        assert!(runtime.completed_workflows.read().is_empty());
    }

    #[test]
    fn event_triggers_are_loaded_once_and_dropped_when_definitions_change() {
        let runtime = RuntimeTasks::default();
        let workflow = |id: &str, node_type: &str| WorkflowDefinition {
            id: id.into(),
            nodes: vec![WorkflowNode {
                node_type: node_type.into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let loads = std::cell::Cell::new(0);
        let load = || {
            loads.set(loads.get() + 1);
            Ok(vec![
                workflow("on-job", "job_event"),
                workflow("manual", "manual"),
            ])
        };

        let first = runtime.event_triggers(load).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, "on-job");
        runtime.event_triggers(load).unwrap();
        assert_eq!(loads.get(), 1);

        runtime.invalidate_workflow("on-job");
        runtime.event_triggers(load).unwrap();
        assert_eq!(loads.get(), 2);

        // A failed load is reported and retried, not cached.
        runtime.invalidate_all();
        assert!(runtime.event_triggers(|| Err("storage".into())).is_err());
        runtime.event_triggers(load).unwrap();
        assert_eq!(loads.get(), 3);

        // Edited while loading: the list is returned but not kept.
        runtime.invalidate_all();
        let stale = runtime
            .event_triggers(|| {
                runtime.invalidate_workflow("on-job");
                Ok(vec![workflow("old", "job_event")])
            })
            .unwrap();
        assert_eq!(stale[0].id, "old");
        let fresh = runtime.event_triggers(load).unwrap();
        assert_eq!(fresh[0].id, "on-job");
    }

    #[test]
    fn a_workflow_keeps_the_quick_runs_it_names_even_without_a_vault() {
        let directory = tempfile::tempdir().unwrap();
        let manager: AppSettingsManager = rcman::SettingsManager::builder("snapshot-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_QUICK_RUNS).with_profiles())
            .build()
            .unwrap();
        assert!(!manager.is_vault_enabled());
        let preset = |id: &str| -> QuickRun {
            serde_json::from_value(json!({"id": id, "name": id, "remoteName": "drive", "operationType": "copy", "config": {"source": "/a", "dest": "/b"}})).unwrap()
        };
        let quick_runs = manager.sub_settings(SUB_QUICK_RUNS).unwrap();
        for id in ["used", "unrelated"] {
            quick_runs.set(id, &preset(id)).unwrap();
        }
        let workflow = WorkflowDefinition {
            nodes: vec![
                WorkflowNode {
                    node_type: "quick_run".into(),
                    config: json!({"quickRunId": " used "}),
                    ..Default::default()
                },
                WorkflowNode {
                    node_type: "quick_run".into(),
                    config: json!({"quickRunId": "{{nodes.x.id}}"}),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let snapshot = WorkflowSnapshot::capture(&manager, workflow).unwrap();
        assert_eq!(snapshot.quick_runs.keys().collect::<Vec<_>>(), ["used"]);

        // A later backend switch changes what the store shows, not what the run holds.
        quick_runs.profiles().unwrap().create("Other").unwrap();
        quick_runs.profiles().unwrap().switch("Other").unwrap();
        assert!(quick_runs.get_value("used").is_err());
        assert_eq!(snapshot.quick_runs["used"].id, "used");
    }
}
