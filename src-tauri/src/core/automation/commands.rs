use crate::core::automation::engine::{
    AutomationScheduler, get_next_run, validate_cron_expression,
};
use crate::rclone::state::automations::AutomationsCache;
use crate::utils::types::automation::{Automation, AutomationStatus, CronValidationResponse};
use log::{error, info, warn};
use tauri::{AppHandle, Manager};

/// Toggle automation scheduling state.
#[tauri::command]
pub async fn toggle_automation(
    app: AppHandle,
    automation_id: String,
) -> Result<Automation, String> {
    info!("Toggling automation: {automation_id}");

    let cache = app.state::<AutomationsCache>();
    let scheduler = app.state::<AutomationScheduler>();

    let automation = cache
        .toggle_automation_status(&automation_id, Some(&app))
        .await?;

    if let Err(e) = scheduler
        .reschedule_automation(&automation, cache.clone())
        .await
    {
        error!("Failed to reload automations after toggle: {e}");
    } else {
        let automation_name = format!(
            "{}: {}-{}.{}",
            automation.backend_name, automation.remote_name, automation.profile_name, automation.id
        );

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

    let watcher_manager = app.state::<crate::core::automation::watcher::WatcherManager>();
    if let Err(e) = watcher_manager.sync_watchers(app.clone()).await {
        error!("Failed to sync watchers after toggle: {e}");
    }

    Ok(automation)
}

/// Validate a cron expression
#[tauri::command]
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
#[tauri::command]
pub async fn reload_automations(app: AppHandle) -> Result<(), String> {
    info!("Reloading all automations");
    let scheduler = app.state::<AutomationScheduler>();

    scheduler.reload_automations(app.clone()).await?;

    info!("Automations reloaded");
    Ok(())
}

/// Clear all automations
#[tauri::command]
pub async fn clear_all_automations(app: AppHandle) -> Result<(), String> {
    info!("Clearing all automations");

    let cache = app.state::<AutomationsCache>();
    let scheduler = app.state::<AutomationScheduler>();

    let automations = cache.get_all_automations().await;

    for automation in automations {
        if let Some(job_id_str) = automation.scheduler_job_id
            && let Ok(job_id) = uuid::Uuid::parse_str(&job_id_str)
            && let Err(e) = scheduler.unschedule_automation(job_id).await
        {
            warn!("Failed to unschedule job {job_id}: {e}");
        }
    }

    cache.clear_all_automations(Some(&app)).await?;

    info!("All automations cleared");
    Ok(())
}

/// Reload automations from remote configs
#[tauri::command]
pub async fn reload_automations_from_configs(
    app: AppHandle,
    all_settings: serde_json::Value,
) -> Result<usize, String> {
    info!("Reloading automations from configs...");

    let cache = app.state::<AutomationsCache>();
    let scheduler = app.state::<AutomationScheduler>();
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    let result = cache
        .load_from_remote_configs(&all_settings, &backend_name, Some(&app))
        .await?;

    let counts = (
        result.added.len(),
        result.updated.len(),
        result.removed.len(),
    );

    scheduler.apply_cache_result(&result, cache).await?;

    let watcher_manager = app.state::<crate::core::automation::watcher::WatcherManager>();
    if let Err(e) = watcher_manager.sync_watchers(app.clone()).await {
        error!("Failed to sync watchers after config reload: {e}");
    }

    info!(
        "Reload complete: {} added, {} updated, {} removed",
        counts.0, counts.1, counts.2,
    );

    Ok(counts.0)
}
