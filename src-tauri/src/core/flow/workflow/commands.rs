//! Tauri commands for the Flow workspace Workflow feature.

use chrono::Utc;
use log::info;
use tauri::{AppHandle, Manager};

use super::dag::validate_workflow as validate_dag;
use super::types::{
    WorkflowDefinition, WorkflowExecutionResult, WorkflowInput, WorkflowValidationResult,
};
use crate::core::{bridge, settings::AppSettingsManager};
use crate::utils::constants::SUB_WORKFLOWS;

/// Lists all saved workflows from storage.
#[bridge]
pub async fn list_workflows(app: AppHandle) -> Result<Vec<WorkflowDefinition>, String> {
    let manager = app.state::<AppSettingsManager>();
    get_all_workflows_sync(&manager)
}

/// Retrieves a single workflow by ID.
#[bridge]
pub async fn get_workflow(
    app: AppHandle,
    workflow_id: String,
) -> Result<WorkflowDefinition, String> {
    let manager = app.state::<AppSettingsManager>();
    get_workflow_by_id(&manager, &workflow_id)?
        .ok_or_else(|| format!("Workflow '{workflow_id}' not found"))
}

/// Creates a new workflow record.
#[bridge]
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
        auto_start: workflow.auto_start,
        cron_expression: workflow.cron_expression,
        created_at: Some(now.clone()),
        updated_at: Some(now),
        last_executed_at: None,
    };

    save_workflow_record(&manager, &record)?;
    sync_workflow_automations_bg(&app).await;
    Ok(record)
}

/// Updates an existing workflow record.
#[bridge]
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
    existing.auto_start = workflow.auto_start;
    existing.cron_expression = workflow.cron_expression;
    existing.updated_at = Some(Utc::now().to_rfc3339());

    save_workflow_record(&manager, &existing)?;
    sync_workflow_automations_bg(&app).await;
    Ok(existing)
}

/// Deletes a workflow by ID.
#[bridge]
pub async fn delete_workflow(app: AppHandle, workflow_id: String) -> Result<(), String> {
    info!("Deleting workflow: {workflow_id}");
    let manager = app.state::<AppSettingsManager>();
    delete_workflow_by_id_sync(&manager, &workflow_id)?;
    sync_workflow_automations_bg(&app).await;
    Ok(())
}

/// Duplicates an existing workflow with a unique name.
#[bridge]
pub async fn duplicate_workflow(
    app: AppHandle,
    workflow_id: String,
) -> Result<WorkflowDefinition, String> {
    let manager = app.state::<AppSettingsManager>();
    let existing = get_workflow_by_id(&manager, &workflow_id)?
        .ok_or_else(|| format!("Workflow '{workflow_id}' not found"))?;

    let all = get_all_workflows_sync(&manager)?;
    let existing_names: Vec<String> = all.into_iter().map(|w| w.name).collect();

    let base_name = format!("{} (Copy)", existing.name);
    let mut new_name = base_name.clone();
    let mut counter = 2;

    while existing_names.contains(&new_name) {
        new_name = format!("{base_name} {counter}");
        counter += 1;
    }

    let now = Utc::now().to_rfc3339();
    let new_id = format!("wf-{}", uuid::Uuid::new_v4());

    let duplicated = WorkflowDefinition {
        id: new_id,
        name: new_name,
        description: existing.description,
        nodes: existing.nodes,
        edges: existing.edges,
        viewport: existing.viewport,
        auto_start: existing.auto_start,
        cron_expression: existing.cron_expression,
        created_at: Some(now.clone()),
        updated_at: Some(now),
        last_executed_at: None,
    };

    save_workflow_record(&manager, &duplicated)?;
    sync_workflow_automations_bg(&app).await;
    Ok(duplicated)
}

/// Validates a workflow's DAG structure without executing it.
#[bridge]
pub async fn validate_workflow(
    workflow: WorkflowDefinition,
) -> Result<WorkflowValidationResult, String> {
    Ok(validate_dag(&workflow))
}

/// Executes a workflow by ID, optionally in simulation (dry-run) mode.
#[bridge]
pub async fn execute_workflow(
    app: AppHandle,
    workflow_id: String,
    dry_run: Option<bool>,
) -> Result<WorkflowExecutionResult, String> {
    super::engine::execute_workflow(app, workflow_id, dry_run.unwrap_or(false)).await
}

/// Stops an actively running workflow.
#[bridge]
pub async fn stop_workflow(app: AppHandle, workflow_id: String) -> Result<(), String> {
    super::engine::stop_workflow(&app, &workflow_id).await
}

/// Exports a workflow definition as formatted JSON.
#[bridge]
pub async fn export_workflow(app: AppHandle, workflow_id: String) -> Result<String, String> {
    let manager = app.state::<AppSettingsManager>();
    let wf = get_workflow_by_id(&manager, &workflow_id)?
        .ok_or_else(|| format!("Workflow '{workflow_id}' not found"))?;

    serde_json::to_string_pretty(&wf).map_err(|e| format!("Failed to serialize workflow JSON: {e}"))
}

/// Imports and persists a workflow from a JSON string.
#[bridge]
pub async fn import_workflow(
    app: AppHandle,
    json_str: String,
) -> Result<WorkflowDefinition, String> {
    let mut parsed: WorkflowDefinition =
        serde_json::from_str(&json_str).map_err(|e| format!("Invalid workflow JSON: {e}"))?;

    let manager = app.state::<AppSettingsManager>();
    let all = get_all_workflows_sync(&manager)?;
    let existing_names: Vec<String> = all.into_iter().map(|w| w.name).collect();

    let base_name = if parsed.name.trim().is_empty() {
        "Imported Workflow".to_string()
    } else {
        format!("{} (Imported)", parsed.name)
    };

    let mut new_name = base_name.clone();
    let mut counter = 2;
    while existing_names.contains(&new_name) {
        new_name = format!("{base_name} {counter}");
        counter += 1;
    }

    let now = Utc::now().to_rfc3339();
    parsed.id = format!("wf-{}", uuid::Uuid::new_v4());
    parsed.name = new_name;
    parsed.created_at = Some(now.clone());
    parsed.updated_at = Some(now);

    save_workflow_record(&manager, &parsed)?;
    sync_workflow_automations_bg(&app).await;
    Ok(parsed)
}

// ── Persistence Helpers ──────────────────────────────────────────────────

pub fn get_all_workflows_sync(
    manager: &AppSettingsManager,
) -> Result<Vec<WorkflowDefinition>, String> {
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;

    let values = sub.get_all_values().unwrap_or_default();
    let mut list: Vec<WorkflowDefinition> = values
        .into_values()
        .filter_map(|v| serde_json::from_value::<WorkflowDefinition>(v).ok())
        .collect();

    list.sort_by_key(|a| a.name.to_lowercase());
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
        Err(_) => Ok(None),
    }
}

pub fn save_workflow_record(
    manager: &AppSettingsManager,
    wf: &WorkflowDefinition,
) -> Result<(), String> {
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

pub async fn sync_workflow_automations_bg(app: &AppHandle) {
    let manager = app.state::<AppSettingsManager>();
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let cache_state = app.state::<crate::rclone::state::automations::AutomationsCache>();
    let scheduler_state = app.state::<crate::core::automation::engine::AutomationScheduler>();

    if let Ok(workflows) = get_all_workflows_sync(&manager) {
        let backend_name = backend_manager.get_active_name().await;
        if let Ok(result) = cache_state
            .load_from_workflows(&workflows, &backend_name, Some(app))
            .await
        {
            let _ = scheduler_state
                .apply_cache_result(&result, cache_state)
                .await;
        }

        let watcher_manager = app.state::<crate::core::automation::watcher::WatcherManager>();
        if let Err(e) = watcher_manager.sync_watchers(app.clone()).await {
            log::error!("Failed to sync watchers for workflows: {e}");
        }
    }

    #[cfg(all(desktop, feature = "tray"))]
    let _ = crate::core::tray::core::update_tray_menu(app.clone()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::flow::workflow::types::*;
    use crate::core::settings::schema::AppSettings;
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
    fn test_workflow_crud_operations() {
        let (_temp, manager) = test_manager();

        let wf = WorkflowDefinition {
            id: "wf-test-1".to_string(),
            name: "Test Flow".to_string(),
            description: Some("My flow".to_string()),
            nodes: vec![],
            edges: vec![],
            viewport: CanvasViewport::default(),
            auto_start: false,
            cron_expression: Some("0 3 * * *".to_string()),
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

        // 4. List
        let list = get_all_workflows_sync(&manager).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "wf-test-1");

        // 5. Delete
        delete_workflow_by_id_sync(&manager, "wf-test-1").unwrap();
        let after_delete = get_workflow_by_id(&manager, "wf-test-1").unwrap();
        assert!(after_delete.is_none());
    }
}
