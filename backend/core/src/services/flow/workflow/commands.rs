//! Tauri commands for the Flow workspace Workflow feature.

use std::collections::HashSet;

use crate::context::AppHandle;
use chrono::Utc;
use log::info;

use super::types::{NodeKind, WorkflowDefinition, WorkflowExecutionResult, WorkflowInput};
use crate::services::settings::AppSettingsManager;
use crate::utils::constants::SUB_WORKFLOWS;

/// Lists all saved workflows from storage.
pub async fn list_workflows(app: AppHandle) -> Result<Vec<WorkflowDefinition>, String> {
    let manager = app.state::<AppSettingsManager>();
    get_all_workflows_sync(&manager)
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
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_workflow(&record.id);
    }
    sync_workflow_automations(&app).await?;
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
        .ok_or_else(|| "Missing workflow ID for update".to_string())?;

    info!("Updating workflow: {id}");

    let mut existing =
        get_workflow_by_id(&manager, id)?.ok_or_else(|| format!("Workflow '{id}' not found"))?;

    existing.name = workflow.name;
    existing.description = workflow.description;
    existing.nodes = workflow.nodes;
    existing.edges = workflow.edges;
    existing.viewport = workflow.viewport;
    existing.show_on_tray = workflow.show_on_tray;
    existing.updated_at = Some(Utc::now().to_rfc3339());

    save_workflow_record(&manager, &existing)?;
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_workflow(&existing.id);
    }
    sync_workflow_automations(&app).await?;
    Ok(existing)
}

/// Deletes a workflow by ID.
pub async fn delete_workflow(app: AppHandle, workflow_id: String) -> Result<(), String> {
    info!("Deleting workflow: {workflow_id}");
    let manager = app.state::<AppSettingsManager>();
    delete_workflow_by_id_sync(&manager, &workflow_id)?;
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_workflow(&workflow_id);
    }
    sync_workflow_automations(&app).await?;
    Ok(())
}

/// Duplicates an existing workflow with a unique name.
pub async fn duplicate_workflow(
    app: AppHandle,
    workflow_id: String,
) -> Result<WorkflowDefinition, String> {
    let manager = app.state::<AppSettingsManager>();
    let existing = get_workflow_by_id(&manager, &workflow_id)?
        .ok_or_else(|| format!("Workflow '{workflow_id}' not found"))?;

    let all = get_all_workflows_sync(&manager)?;
    let existing_names: HashSet<String> = all.into_iter().map(|w| w.name).collect();

    let base_name = format!("{} (Copy)", existing.name);
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
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_workflow(&duplicated.id);
    }
    sync_workflow_automations(&app).await?;
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
    super::engine::execute_workflow(app, backend, workflow_id, dry_run.unwrap_or(false)).await
}

/// Stops an actively running workflow.
pub async fn stop_workflow(app: AppHandle, workflow_id: String) -> Result<(), String> {
    super::engine::stop_workflow(&app, &workflow_id).await
}

/// Executes an arbitrary Rclone Remote Control (RC) command for testing and schema discovery.
pub async fn test_rc_command(
    app: AppHandle,
    command: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    use crate::services::flow::workflow::engine::parse_rc_params;
    use crate::utils::types::state::RcloneState;

    let state = app.state::<RcloneState>();
    let parsed_params = parse_rc_params(params.as_ref())?;
    state
        .transport
        .rpc(&command, Some(&parsed_params))
        .await
        .map_err(|e| format!("RC command '{command}' failed: {e}"))
}

// ── Persistence Helpers ──────────────────────────────────────────────────

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

pub fn get_all_workflows_sync(
    manager: &AppSettingsManager,
) -> Result<Vec<WorkflowDefinition>, String> {
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
        .map_err(|e| format!("Failed to save workflow: {e}"))
}

pub fn save_workflow_record(
    manager: &AppSettingsManager,
    wf: &WorkflowDefinition,
) -> Result<(), String> {
    for node in &wf.nodes {
        if matches!(node.kind(), NodeKind::Cron | NodeKind::ScheduleWait) {
            crate::services::automation::engine::validate_enabled_cron(
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
        .map_err(|e| format!("Failed to save workflow: {e}"))
}

pub fn delete_workflow_by_id_sync(manager: &AppSettingsManager, id: &str) -> Result<(), String> {
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;

    sub.delete(id)
        .map_err(|e| format!("Failed to delete workflow: {e}"))
}

pub async fn sync_workflow_automations(app: &AppHandle) -> Result<(), String> {
    use crate::rclone::{backend::BackendManager, state::automations::AutomationsCache};
    use crate::services::automation::engine::apply_and_sync_automations;
    use crate::services::settings::AppSettingsManager;

    let manager = app.state::<AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();
    let backend_manager = app.state::<BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    let revision = app
        .state::<crate::services::automation::runtime::RuntimeTasks>()
        .revision();
    let workflows = get_all_workflows_sync(&manager)?;
    cache.load_from_workflows(&workflows, &backend_name).await?;
    crate::services::automation::runtime::refresh_with_definitions(
        app,
        Some(revision),
        None,
        Some(workflows),
    )
    .await?;
    apply_and_sync_automations(app).await
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
        let list = get_all_workflows_sync(&manager).unwrap();
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
        let list = get_all_workflows_sync(&manager).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "wf-test-1");

        // 5. Delete
        delete_workflow_by_id_sync(&manager, "wf-test-1").unwrap();
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

        let all = get_all_workflows_sync(&manager).unwrap();
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
