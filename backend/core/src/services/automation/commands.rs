use crate::context::AppHandle;
use log::{error, info};

use crate::{
    rclone::state::automations::AutomationsCache,
    services::automation::engine::{AutomationScheduler, get_next_run, validate_cron_expression},
    utils::types::automation::{Automation, AutomationStatus, CronValidationResponse},
};

/// Toggle automation scheduling state.
pub async fn toggle_automation(
    app: AppHandle,
    automation_id: String,
) -> Result<Automation, String> {
    info!("Toggling automation: {automation_id}");

    let cache = app.state::<AutomationsCache>();
    let scheduler = app.state::<AutomationScheduler>();

    let automation = cache.toggle_automation_status(&automation_id).await?;

    super::runtime::refresh(&app).await?;
    let schedule_result = scheduler
        .reschedule_automation(&automation_id, cache.clone())
        .await;
    if let Err(e) = &schedule_result {
        error!("Failed to reload automations after toggle: {e}");
    } else {
        let automation_name = automation.log_name();

        info!(
            "Automation {} {}",
            match automation.status {
                AutomationStatus::Enabled => "enabled and scheduled",
                AutomationStatus::Stopping => "disabling after current run",
                _ => "disabled and unscheduled",
            },
            automation_name
        );
    }

    let watcher_manager = app.state::<crate::services::automation::watcher::WatcherManager>();
    let watch_result = watcher_manager.sync_watchers(app.clone()).await;
    schedule_result?;
    watch_result?;
    Ok(automation)
}

/// Validate a cron expression
pub async fn validate_cron(cron_expression: String) -> Result<CronValidationResponse, String> {
    match validate_cron_expression(&cron_expression) {
        Ok(()) => {
            let next_run = get_next_run(&cron_expression).ok();

            Ok(CronValidationResponse {
                is_valid: true,
                error_message: None,
                next_run,
            })
        }
        Err(e) => Ok(CronValidationResponse {
            is_valid: false,
            error_message: Some(e),
            next_run: None,
        }),
    }
}

/// Reload all automations
pub async fn reload_automations(app: AppHandle) -> Result<(), String> {
    info!("Reloading all automations");
    super::runtime::refresh(&app).await?;
    crate::services::automation::engine::apply_and_sync_automations(&app).await
}

/// Clear definitions, then reconcile actual scheduler jobs and watchers. Failed
/// removals remain tracked by the scheduler for a subsequent retry.
pub async fn clear_all_automations(app: AppHandle) -> Result<(), String> {
    app.state::<AutomationsCache>()
        .clear_all_automations()
        .await?;
    super::runtime::refresh(&app).await?;
    crate::services::automation::engine::apply_and_sync_automations(&app).await
}

/// Load all automation sources, then prepare and reconcile them once.
pub async fn reload_automations_from_configs(app: &AppHandle) -> Result<usize, String> {
    info!("Reloading automations from configs...");

    let manager = app.state::<crate::services::settings::AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();
    // Engine/cache events continue during a lock. An unreadable configuration
    // must never be interpreted as deletion of every scheduled task.
    if manager.is_locked() {
        return Ok(cache.get_all_automations().await.len());
    }
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let revision = app.state::<super::runtime::RuntimeTasks>().revision();
    let (backend, all_settings) = backend_manager.active_remote_configs(manager.inner()).await;
    if manager.is_locked() {
        return Ok(cache.get_all_automations().await.len());
    }
    let quick_runs = crate::services::flow::quick_run::commands::get_all_quick_runs_sync(&manager)?;
    let workflows = crate::services::flow::workflow::commands::get_all_workflows_sync(&manager)?;

    let result = cache
        .load_from_remote_configs(&all_settings, &backend.name)
        .await?;
    cache
        .load_from_quick_runs(&quick_runs, &backend.name)
        .await?;
    cache.load_from_workflows(&workflows, &backend.name).await?;

    let counts = (
        result.added.len(),
        result.updated.len(),
        result.removed.len(),
    );

    // Backend changes also affect unchanged cache entries: suspend their old
    // cron jobs and reinstall those belonging to the newly selected backend.
    super::runtime::refresh_with_definitions(
        app,
        Some(revision),
        Some(quick_runs),
        Some(workflows),
    )
    .await?;
    super::engine::apply_and_sync_automations(app).await?;

    info!(
        "Reload complete: {} added, {} updated, {} removed",
        counts.0, counts.1, counts.2,
    );

    Ok(counts.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{
        automation::watcher::WatcherManager,
        flow::workflow::types::{WorkflowDefinition, WorkflowNode},
        settings::{AppSettingsManager, access::tests::app},
    };

    #[tokio::test]
    async fn reload_replaces_cached_workflow_schedules_after_restore() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = app(directory.path());
        app.manage(AutomationScheduler::new());
        app.manage(WatcherManager::new());
        let scheduler = app.state::<AutomationScheduler>();
        scheduler.initialize(app.clone()).await.unwrap();
        scheduler.start().await.unwrap();
        let mut workflow = WorkflowDefinition {
            id: "restored-workflow".into(),
            nodes: vec![WorkflowNode {
                node_type: "cron".into(),
                config: serde_json::json!({"cronExpression": "0 3 * * *"}),
                ..Default::default()
            }],
            ..Default::default()
        };
        let cache = app.state::<AutomationsCache>();
        cache
            .load_from_workflows(std::slice::from_ref(&workflow), "Local")
            .await
            .unwrap();
        workflow.nodes[0].config["cronExpression"] = serde_json::json!("0 4 * * *");
        app.state::<AppSettingsManager>()
            .sub_settings(crate::utils::constants::SUB_WORKFLOWS)
            .unwrap()
            .set(&workflow.id, &workflow)
            .unwrap();
        reload_automations_from_configs(&app).await.unwrap();
        let automation = cache.get_automation(&workflow.id).await.unwrap();
        assert_eq!(automation.cron_expression.as_deref(), Some("0 4 * * *"));
        assert!(automation.scheduler_job_id.is_some());
        scheduler.stop().await.unwrap();
    }
}
