//! Tauri commands for the Flow workspace Workflow feature.

use std::collections::HashSet;

use crate::context::AppHandle;
use chrono::Utc;
use log::info;

use super::types::{
    NodeKind, WorkflowDefinition, WorkflowExecutionResult, WorkflowInput, WorkflowValidationResult,
};
use crate::services::settings::AppSettingsManager;
use crate::utils::constants::SUB_WORKFLOWS;

/// Lists all saved workflows from storage.
pub async fn list_workflows(app: AppHandle) -> Result<Vec<WorkflowDefinition>, String> {
    let manager = app.state::<AppSettingsManager>();
    get_all_workflows(&manager)
}

/// The latest run of every workflow on the active backend: the ones under way and the
/// last that ended. Run state lives in the backend and is only announced by events, so
/// a view opened after a run began (an auto-start, a schedule, a file watcher, or a
/// reload of the interface) starts from these and then follows the events.
pub async fn get_workflow_runs(
    app: AppHandle,
) -> Result<Vec<super::engine::record::WorkflowRunSnapshot>, String> {
    let backend = app
        .state::<crate::rclone::backend::BackendManager>()
        .get_active_name()
        .await;
    Ok(super::engine::run_snapshots(&backend))
}

/// Creates a new workflow record.
pub async fn create_workflow(
    app: AppHandle,
    workflow: WorkflowInput,
) -> Result<WorkflowDefinition, String> {
    info!("Creating workflow: {}", workflow.name);
    let manager = app.state::<AppSettingsManager>();

    let id = workflow
        .id
        .unwrap_or_else(|| format!("wf-{}", uuid::Uuid::new_v4()));

    let now = Utc::now().to_rfc3339();

    let record = WorkflowDefinition {
        id,
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
        viewport: workflow.viewport,
        show_on_tray: workflow.show_on_tray,
        created_at: Some(now.clone()),
        updated_at: Some(now),
        last_executed_at: None,
    };

    save_workflow_record(&manager, &record)?;
    refresh_after_change(&app, &record.id).await?;
    Ok(record)
}

/// Updates an existing workflow record.
pub async fn update_workflow(
    app: AppHandle,
    workflow: WorkflowInput,
) -> Result<WorkflowDefinition, String> {
    let manager = app.state::<AppSettingsManager>();
    let id = workflow
        .id
        .as_deref()
        .ok_or_else(|| crate::localized_error!("backendErrors.workflow.missingWorkflowId"))?;

    info!("Updating workflow: {id}");

    let mut existing = get_workflow_by_id(&manager, id)?.ok_or_else(
        || crate::localized_error!("backendErrors.workflow.workflowNotFound", "id" => id),
    )?;

    existing.name = workflow.name;
    existing.description = workflow.description;
    existing.nodes = workflow.nodes;
    existing.edges = workflow.edges;
    existing.viewport = workflow.viewport;
    existing.show_on_tray = workflow.show_on_tray;
    existing.updated_at = Some(Utc::now().to_rfc3339());

    save_workflow_record(&manager, &existing)?;
    refresh_after_change(&app, &existing.id).await?;
    Ok(existing)
}

/// Deletes a workflow by ID.
pub async fn delete_workflow(app: AppHandle, workflow_id: String) -> Result<(), String> {
    info!("Deleting workflow: {workflow_id}");
    let manager = app.state::<AppSettingsManager>();
    delete_workflow_by_id(&manager, &workflow_id)?;
    super::engine::forget_workflow_runs(&workflow_id);
    refresh_after_change(&app, &workflow_id).await?;
    Ok(())
}

/// Duplicates an existing workflow with a unique name.
pub async fn duplicate_workflow(
    app: AppHandle,
    workflow_id: String,
) -> Result<WorkflowDefinition, String> {
    let manager = app.state::<AppSettingsManager>();
    let existing = get_workflow_by_id(&manager, &workflow_id)?.ok_or_else(
        || crate::localized_error!("backendErrors.workflow.workflowNotFound", "id" => workflow_id),
    )?;

    let all = get_all_workflows(&manager)?;
    let existing_names: HashSet<String> = all.into_iter().map(|w| w.name).collect();

    let base_name = crate::t!("backendErrors.workflow.copyName", "name" => existing.name);
    let new_name = find_unique_name(&existing_names, &base_name);

    let now = Utc::now().to_rfc3339();
    let new_id = format!("wf-{}", uuid::Uuid::new_v4());

    let duplicated = WorkflowDefinition {
        id: new_id,
        name: new_name,
        description: existing.description,
        nodes: existing.nodes,
        edges: existing.edges,
        viewport: existing.viewport,
        show_on_tray: existing.show_on_tray,
        created_at: Some(now.clone()),
        updated_at: Some(now),
        last_executed_at: None,
    };

    save_workflow_record(&manager, &duplicated)?;
    refresh_after_change(&app, &duplicated.id).await?;
    Ok(duplicated)
}

/// Executes a workflow by ID, optionally in simulation (dry-run) mode.
pub async fn execute_workflow(
    app: AppHandle,
    workflow_id: String,
    dry_run: Option<bool>,
) -> Result<WorkflowExecutionResult, String> {
    let backend = app
        .state::<crate::rclone::backend::BackendManager>()
        .get_active()
        .await;
    super::engine::execute_workflow(
        app,
        backend,
        workflow_id,
        dry_run.unwrap_or(false),
        super::engine::RunTrigger::Manual,
    )
    .await
}

/// Checks a workflow the way a run would, without storing it, so the canvas can show what
/// would stop a run (errors) or probably is not meant (warnings) before one is started.
pub async fn validate_workflow(
    workflow: WorkflowInput,
) -> Result<WorkflowValidationResult, String> {
    let definition = WorkflowDefinition {
        id: workflow.id.unwrap_or_default(),
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
        viewport: workflow.viewport,
        show_on_tray: workflow.show_on_tray,
        created_at: None,
        updated_at: None,
        last_executed_at: None,
    };
    Ok(super::dag::validate_workflow(&definition))
}

/// Stops an actively running workflow.
pub async fn stop_workflow(app: AppHandle, workflow_id: String) -> Result<(), String> {
    super::engine::stop_workflow(&app, &workflow_id).await
}

// ── Persistence Helpers ──────────────────────────────────────────────────

/// Drops what is cached for a changed workflow and re-applies the schedules and watchers.
async fn refresh_after_change(app: &AppHandle, workflow_id: &str) -> Result<(), String> {
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_workflow(workflow_id);
    }
    crate::services::automation::commands::sync_flow_automations(app).await
}

/// Finds a unique workflow name by appending sequential numbers if a collision occurs with existing names.
pub fn find_unique_name(existing_names: &HashSet<String>, base_name: &str) -> String {
    if !existing_names.contains(base_name) {
        return base_name.to_string();
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{base_name} {counter}");
        if !existing_names.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

pub fn get_all_workflows(manager: &AppSettingsManager) -> Result<Vec<WorkflowDefinition>, String> {
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;

    let values = sub.get_all_values().map_err(|error| error.to_string())?;
    let mut list: Vec<WorkflowDefinition> =
        crate::utils::json_helpers::decode_valid(values, "workflow");
    list.sort_by_cached_key(|a| a.name.to_lowercase());
    Ok(list)
}

pub fn get_workflow_by_id(
    manager: &AppSettingsManager,
    id: &str,
) -> Result<Option<WorkflowDefinition>, String> {
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;

    match sub.get::<WorkflowDefinition>(id) {
        Ok(wf) => Ok(Some(wf)),
        Err(rcman::Error::SubSettingsEntryNotFound(_)) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Records when a workflow last ran without rewriting the rest of its definition,
/// which may have been edited or deleted while it executed. A missing workflow
/// is left missing.
pub(crate) fn record_last_executed(
    manager: &AppSettingsManager,
    id: &str,
    timestamp: &str,
) -> Result<(), String> {
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;
    // One field is rewritten under the store's own lock, so a concurrent edit is not
    // overwritten and a concurrent delete is not undone.
    sub.set_field_if_exists(id, "lastExecutedAt", &timestamp)
        .map(|_| ())
        .map_err(|e| crate::localized_error!("backendErrors.workflow.saveFailed", "error" => e))
}

pub fn save_workflow_record(
    manager: &AppSettingsManager,
    wf: &WorkflowDefinition,
) -> Result<(), String> {
    for node in &wf.nodes {
        if matches!(node.kind(), NodeKind::Cron | NodeKind::ScheduleWait) {
            crate::utils::cron::validate_enabled_cron(
                true,
                node.config
                    .get("cronExpression")
                    .and_then(serde_json::Value::as_str),
            )?;
        }
    }
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;

    sub.set(&wf.id, wf)
        .map_err(|e| crate::localized_error!("backendErrors.workflow.saveFailed", "error" => e))
}

pub fn delete_workflow_by_id(manager: &AppSettingsManager, id: &str) -> Result<(), String> {
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;

    sub.delete(id)
        .map_err(|e| crate::localized_error!("backendErrors.workflow.deleteFailed", "error" => e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::flow::workflow::types::*;
    use crate::services::settings::schema::AppSettings;
    use tempfile::TempDir;

    fn test_manager() -> (TempDir, AppSettingsManager) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<AppSettings>()
            .build();
        let manager = rcman::SettingsManager::new(config).expect("Failed to create manager");

        manager
            .register_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_WORKFLOWS))
            .expect("Failed to register workflows sub-settings");

        (temp_dir, manager)
    }

    #[tokio::test]
    async fn validating_a_workflow_reports_what_a_run_would_reject_without_storing_it() {
        let node = |id: &str, title: &str| WorkflowNode {
            id: id.into(),
            title: title.into(),
            ..Default::default()
        };
        let input = WorkflowInput {
            id: None,
            name: "Unsaved".into(),
            description: None,
            nodes: vec![node("a", "Alpha"), node("b", "Beta")],
            edges: vec![WorkflowEdge {
                id: "e1".into(),
                source_node_id: "a".into(),
                source_port_id: "out".into(),
                target_node_id: "ghost".into(),
                target_port_id: "in".into(),
                is_active: None,
            }],
            viewport: CanvasViewport::default(),
            show_on_tray: false,
        };

        let result = validate_workflow(input).await.unwrap();

        assert!(!result.valid);
        assert!(
            result
                .errors
                .iter()
                .any(|e| e.contains("backendErrors.workflow.validationMissingTarget"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("backendErrors.workflow.validationDisconnected"))
        );
    }

    #[tokio::test]
    async fn workflow_runs_list_the_active_backend_only_and_keep_the_last_run() {
        use std::sync::Arc;

        use crate::rclone::backend::{BackendManager, types::Backend};
        use crate::services::flow::workflow::engine::{
            active::{ActiveWorkflowState, register_active_run},
            cancel::CancelToken,
            record::RunHandle,
        };

        let app = AppHandle::default();
        app.manage(BackendManager::new());
        let active = app.state::<BackendManager>().get_active_name().await;
        let register = |backend: &str, id: &str| {
            let state = ActiveWorkflowState {
                backend: Backend::new_local(backend),
                cancel: CancelToken::new(),
                active_job_ids: Default::default(),
            };
            register_active_run(
                id,
                id,
                state,
                Arc::new(RunHandle::new(id, "test-run", false)),
            )
            .unwrap()
        };
        let own = register(&active, "wf-runs-b");
        let first = register(&active, "wf-runs-a");
        let elsewhere = register("another-backend", "wf-runs-other");

        let ours = |runs: Vec<super::super::engine::record::WorkflowRunSnapshot>| {
            runs.into_iter()
                .filter(|run| run.workflow_id.starts_with("wf-runs-"))
                .map(|run| run.workflow_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ours(get_workflow_runs(app.clone()).await.unwrap()),
            ["wf-runs-a", "wf-runs-b"]
        );

        // A run that ended stays listed, as the last run of its workflow.
        own.release();
        first.release();
        assert_eq!(
            ours(get_workflow_runs(app.clone()).await.unwrap()),
            ["wf-runs-a", "wf-runs-b"]
        );
        elsewhere.release();
    }

    #[test]
    fn test_workflow_crud_and_invalid_update() {
        let (_temp, manager) = test_manager();

        let wf = WorkflowDefinition {
            id: "wf-test-1".to_string(),
            name: "Arşiv & 旅行".to_string(),
            description: Some("My flow".to_string()),
            nodes: vec![WorkflowNode {
                id: "copy-1".into(),
                node_type: "copy".into(),
                config: serde_json::json!({
                    "srcPaths": ["drive:Arşiv & 旅行", "/path with spaces"],
                    "dstPaths": [],
                }),
                ..Default::default()
            }],
            edges: vec![],
            viewport: CanvasViewport::default(),
            show_on_tray: false,
            created_at: None,
            updated_at: None,
            last_executed_at: None,
        };

        // 1. Initially empty
        let list = get_all_workflows(&manager).unwrap();
        assert!(list.is_empty());

        // 2. Save
        save_workflow_record(&manager, &wf).unwrap();

        // 3. Fetch by ID
        let fetched = get_workflow_by_id(&manager, "wf-test-1").unwrap();
        assert_eq!(fetched, Some(wf.clone()));

        // Invalid schedule updates must leave the stored definition intact.
        let mut invalid = wf.clone();
        invalid.nodes[0].node_type = "cron".into();
        invalid.nodes[0].config = serde_json::json!({ "cronExpression": "not-a-cron" });
        assert!(save_workflow_record(&manager, &invalid).is_err());
        assert_eq!(
            get_workflow_by_id(&manager, "wf-test-1").unwrap(),
            Some(wf.clone())
        );

        // 4. List
        let list = get_all_workflows(&manager).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "wf-test-1");

        // 5. Delete
        delete_workflow_by_id(&manager, "wf-test-1").unwrap();
        let after_delete = get_workflow_by_id(&manager, "wf-test-1").unwrap();
        assert!(after_delete.is_none());
    }

    #[test]
    fn test_find_unique_name() {
        let mut names = HashSet::new();
        assert_eq!(
            find_unique_name(&names, "Workflow (Copy)"),
            "Workflow (Copy)"
        );

        names.insert("Workflow (Copy)".to_string());
        assert_eq!(
            find_unique_name(&names, "Workflow (Copy)"),
            "Workflow (Copy) 2"
        );

        names.insert("Workflow (Copy) 2".to_string());
        assert_eq!(
            find_unique_name(&names, "Workflow (Copy)"),
            "Workflow (Copy) 3"
        );
    }

    #[test]
    fn an_unreadable_record_does_not_hide_the_others() {
        let (_temp_dir, manager) = test_manager();
        let valid = WorkflowDefinition {
            id: "valid".into(),
            name: "Valid".into(),
            ..Default::default()
        };
        save_workflow_record(&manager, &valid).unwrap();
        manager
            .sub_settings(SUB_WORKFLOWS)
            .unwrap()
            .set("damaged", &serde_json::json!({"nodes": "not a list"}))
            .unwrap();

        let all = get_all_workflows(&manager).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "valid");
    }

    #[test]
    fn recording_a_run_changes_only_the_timestamp_and_never_recreates_a_workflow() {
        let (_temp_dir, manager) = test_manager();
        let mut workflow = WorkflowDefinition {
            id: "wf".into(),
            name: "Edited".into(),
            ..Default::default()
        };
        save_workflow_record(&manager, &workflow).unwrap();

        record_last_executed(&manager, "wf", "2026-10-27T12:00:00Z").unwrap();
        workflow = get_workflow_by_id(&manager, "wf").unwrap().unwrap();
        assert_eq!(workflow.name, "Edited");
        assert_eq!(
            workflow.last_executed_at.as_deref(),
            Some("2026-10-27T12:00:00Z")
        );

        record_last_executed(&manager, "gone", "2026-10-27T12:00:00Z").unwrap();
        assert!(get_workflow_by_id(&manager, "gone").unwrap().is_none());
    }
}
