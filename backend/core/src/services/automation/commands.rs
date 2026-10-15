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
    crate::services::automation::engine::apply_and_sync_automations(&app).await
}

/// Clear definitions, then reconcile actual scheduler jobs and watchers. Failed
/// removals remain tracked by the scheduler for a subsequent retry.
pub async fn clear_all_automations(app: AppHandle) -> Result<(), String> {
    app.state::<AutomationsCache>()
        .clear_all_automations()
        .await?;
    crate::services::automation::engine::apply_and_sync_automations(&app).await
}

/// Reload automations from remote configs stored in AppSettingsManager
pub async fn reload_automations_from_configs(app: &AppHandle) -> Result<usize, String> {
    info!("Reloading automations from configs...");

    let manager = app.state::<crate::services::settings::AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();
    let scheduler = app.state::<AutomationScheduler>();
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let (backend, all_settings) = backend_manager.active_remote_configs(manager.inner()).await;

    let result = cache
        .load_from_remote_configs(&all_settings, &backend.name)
        .await?;

    let counts = (
        result.added.len(),
        result.updated.len(),
        result.removed.len(),
    );

    // Backend changes also affect unchanged cache entries: suspend their old
    // cron jobs and reinstall those belonging to the newly selected backend.
    let reconcile_result = scheduler.reload_automations(app.clone()).await;

    let watch_result = app
        .state::<crate::services::automation::watcher::WatcherManager>()
        .sync_watchers(app.clone())
        .await;
    reconcile_result?;
    watch_result?;

    info!(
        "Reload complete: {} added, {} updated, {} removed",
        counts.0, counts.1, counts.2,
    );

    Ok(counts.0)
}
