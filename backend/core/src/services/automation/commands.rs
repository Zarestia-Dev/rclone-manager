use crate::context::AppHandle;
use log::{error, info};

use crate::{
    rclone::state::automations::AutomationsCache,
    services::{
        automation::engine::AutomationScheduler,
        flow::{quick_run::types::QuickRun, workflow::types::WorkflowDefinition},
    },
    utils::{
        cron::{get_next_run, validate_cron_expression},
        types::{
            automation::{Automation, AutomationStatus, CronValidationResponse},
            origin::Origin,
            remotes::OperationType,
        },
    },
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

/// Start an automation now, outside its schedule. The run continues in the background;
/// its outcome lands on the automation like any scheduled run.
pub async fn run_automation(app: AppHandle, automation_id: String) -> Result<(), String> {
    let automation = app
        .state::<AutomationsCache>()
        .get_automation(&automation_id)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.automation.automationNotFound"))?;
    if !automation.can_run() {
        return Err(cannot_run(&automation));
    }
    crate::utils::spawn(async move {
        if let Err(error) = super::engine::execute_automation(&automation_id, &app, None).await {
            error!("Automation execution failed {automation_id}: {error}");
        }
    });
    Ok(())
}

/// Stop the run an automation has in progress.
pub async fn stop_automation(app: AppHandle, automation_id: String) -> Result<(), String> {
    let automation = app
        .state::<AutomationsCache>()
        .get_automation(&automation_id)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.automation.automationNotFound"))?;
    match automation.args.source {
        Origin::Workflow => {
            crate::services::flow::workflow::commands::stop_workflow(app, automation.id).await
        }
        Origin::QuickRun => {
            let job_id = automation
                .current_job_id
                .as_deref()
                .and_then(|id| id.parse().ok());
            crate::services::flow::quick_run::commands::stop_quick_run(app, automation.id, job_id)
                .await
        }
        _ => {
            let job_type = automation
                .automation_type
                .and_then(OperationType::as_job_type)
                .ok_or_else(|| cannot_run(&automation))?;
            crate::rclone::commands::job::stop_job_profile(
                app,
                automation.remote_name.clone(),
                automation.profile_name.clone(),
                job_type,
            )
            .await
        }
    }
}

fn cannot_run(automation: &Automation) -> String {
    crate::localized_error!(
        "backendErrors.automation.automationCannotRun",
        "status" => format!("{:?}", automation.status)
    )
}

/// Validate a cron expression
pub async fn validate_cron(cron_expression: String) -> Result<CronValidationResponse, String> {
    let utc_offset = chrono::Local::now().format("%:z").to_string();
    match validate_cron_expression(&cron_expression) {
        Ok(()) => Ok(CronValidationResponse {
            is_valid: true,
            error_message: None,
            next_run: get_next_run(&cron_expression).ok(),
            utc_offset,
        }),
        Err(e) => Ok(CronValidationResponse {
            is_valid: false,
            error_message: Some(e),
            next_run: None,
            utc_offset,
        }),
    }
}

/// Caches the automations of every Quick Run and workflow. Returns the definitions, so the
/// runtime refresh need not read them again.
pub(crate) async fn load_flow_automations(
    app: &AppHandle,
    backend_name: &str,
) -> Result<(Vec<QuickRun>, Vec<WorkflowDefinition>), String> {
    let manager = app.state::<crate::services::settings::AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();
    let quick_runs = crate::services::flow::quick_run::commands::get_all_quick_runs(&manager)?;
    let workflows = crate::services::flow::workflow::commands::get_all_workflows(&manager)?;
    cache
        .load_from_quick_runs(&quick_runs, backend_name)
        .await?;
    cache.load_from_workflows(&workflows, backend_name).await?;
    Ok((quick_runs, workflows))
}

/// Prepares the task inputs, then brings the scheduler and watchers in line with the cache.
async fn reconcile(
    app: &AppHandle,
    revision: u64,
    quick_runs: Vec<QuickRun>,
    workflows: Vec<WorkflowDefinition>,
) -> Result<(), String> {
    super::runtime::refresh_with_definitions(
        app,
        Some(revision),
        Some(quick_runs),
        Some(workflows),
    )
    .await?;
    super::engine::apply_and_sync_automations(app).await
}

/// Re-reads the Quick Runs and workflows after one of them changed.
pub async fn sync_flow_automations(app: &AppHandle) -> Result<(), String> {
    let revision = app.state::<super::runtime::RuntimeTasks>().revision();
    let backend_name = app
        .state::<crate::rclone::backend::BackendManager>()
        .get_active_name()
        .await;
    let (quick_runs, workflows) = load_flow_automations(app, &backend_name).await?;
    reconcile(app, revision, quick_runs, workflows).await
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
    let result = cache
        .load_from_remote_configs(&all_settings, &backend.name)
        .await?;
    let (quick_runs, workflows) = load_flow_automations(app, &backend.name).await?;

    let counts = (
        result.added.len(),
        result.updated.len(),
        result.removed.len(),
    );

    // Backend changes also affect unchanged cache entries: suspend their old
    // cron jobs and reinstall those belonging to the newly selected backend.
    reconcile(app, revision, quick_runs, workflows).await?;

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
        assert!(scheduler.scheduled_job(&workflow.id).await.is_some());
        scheduler.stop().await.unwrap();
    }

    #[tokio::test]
    async fn cron_validation_reports_the_offset_schedules_fire_in() {
        for (expression, valid) in [("0 3 * * *", true), ("not a cron", false)] {
            let response = validate_cron(expression.to_string()).await.unwrap();
            assert_eq!(response.is_valid, valid, "{expression}");
            assert_eq!(response.next_run.is_some(), valid, "{expression}");
            let offset = response.utc_offset.as_bytes();
            assert!(
                offset.len() == 6 && matches!(offset[0], b'+' | b'-') && offset[3] == b':',
                "{}",
                response.utc_offset
            );
        }
    }
}
