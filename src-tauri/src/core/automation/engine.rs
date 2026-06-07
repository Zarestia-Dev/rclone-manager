//! Cron scheduler engine using tokio-cron-scheduler

use crate::rclone::commands::sync::{TransferType, start_profile_batch};
use crate::rclone::state::automations::{AutomationsCache, CacheUpdateResult};
use crate::utils::app::notification::{AutomationStage, NotificationEvent, notify};
use crate::utils::types::automation::{Automation, AutomationStatus, AutomationType};
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{JobBuilder, JobScheduler};
use uuid::Uuid;

// ============================================================================
// CRON SCHEDULER
// ============================================================================

pub struct AutomationScheduler {
    pub scheduler: Arc<RwLock<Option<JobScheduler>>>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl AutomationScheduler {
    pub fn new() -> Self {
        Self {
            scheduler: Arc::new(RwLock::new(None)),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    /// Initialise the scheduler with the app handle (call once at startup).
    pub async fn initialize(&self, app_handle: AppHandle) -> Result<(), String> {
        info!("Initializing cron scheduler...");

        let scheduler = JobScheduler::new().await.map_err(
            |e| crate::localized_error!("backendErrors.automation.initFailed", "error" => e),
        )?;

        *self.scheduler.write().await = Some(scheduler);
        *self.app_handle.write().await = Some(app_handle);

        info!("Cron scheduler initialized");
        Ok(())
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut guard = self.scheduler.write().await;
        let scheduler = guard.as_mut().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.automation.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        scheduler.start().await.map_err(
            |e| crate::localized_error!("backendErrors.automation.startFailed", "error" => e),
        )?;

        info!("Cron scheduler started");
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut guard = self.scheduler.write().await;
        let scheduler = guard.as_mut().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.automation.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        scheduler.shutdown().await.map_err(
            |e| crate::localized_error!("backendErrors.automation.stopFailed", "error" => e),
        )?;

        info!("Cron scheduler stopped");
        Ok(())
    }

    /// Schedule an automation and return the new scheduler job UUID.
    pub async fn schedule_automation(
        &self,
        automation: &Automation,
        cache: State<'_, AutomationsCache>,
    ) -> Result<Uuid, String> {
        if automation.status != AutomationStatus::Enabled
            && automation.status != AutomationStatus::Failed
        {
            return Err(crate::localized_error!(
                "backendErrors.automation.automationNotEnabled"
            ));
        }

        if let Some(old_job_id_str) = &automation.scheduler_job_id
            && let Ok(old_job_id) = Uuid::parse_str(old_job_id_str)
            && let Err(e) = self.unschedule_automation(old_job_id).await
        {
            warn!(
                "Failed to remove old scheduler job {} for automation '{}': {}",
                old_job_id,
                automation.log_name(),
                e
            );
        }

        let scheduler_guard = self.scheduler.read().await;
        let scheduler = scheduler_guard.as_ref().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.automation.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        let app_guard = self.app_handle.read().await;
        let app_handle = app_guard
            .as_ref()
            .ok_or("App handle not initialized")?
            .clone();

        let automation_id = automation.id.clone();
        let automation_name = format!(
            "{}: {}-{}",
            automation.backend_name, automation.remote_name, automation.profile_name
        );
        let automation_type = automation.automation_type;
        let cron_expr_5_field = automation
            .cron_expression
            .as_deref()
            .ok_or_else(|| "Automation has no cron expression".to_string())?;
        let cron_expr_6_field = format!("0 {cron_expr_5_field}");

        let app_handle_for_job = app_handle.clone();
        let job = JobBuilder::new()
            .with_timezone(Local)
            .with_cron_job_type()
            .with_schedule(&cron_expr_6_field)
            .map_err(
                |e| crate::localized_error!("backendErrors.automation.invalidCron", "error" => e),
            )?
            .with_run_async(Box::new(move |_uuid, _l| {
                let automation_id = automation_id.clone();
                let automation_name = automation_name.clone();
                let automation_type = automation_type;
                let app_handle = app_handle_for_job.clone();

                Box::pin(async move {
                    info!(
                        "Executing scheduled automation: {automation_name} ({automation_id}) — {automation_type:?}"
                    );

                    if let Err(e) = execute_automation(&automation_id, &app_handle).await {
                        error!("Automation execution failed {automation_id}: {e}");
                    } else {
                        info!("Automation execution completed: {automation_id}");
                    }
                })
            }))
            .build()
            .map_err(
                |e| crate::localized_error!("backendErrors.automation.executionFailed", "error" => e),
            )?;

        let job_id = scheduler.add(job).await.map_err(
            |e| crate::localized_error!("backendErrors.automation.executionFailed", "error" => e),
        )?;

        cache
            .update_automation(
                &automation.id,
                |t| {
                    t.scheduler_job_id = Some(job_id.to_string());
                },
                Some(&app_handle),
            )
            .await
            .ok();

        let automation_name = automation.log_name();
        info!("Scheduled '{automation_name}' ({cron_expr_6_field}) — job ID: {job_id}");

        Ok(job_id)
    }

    /// Remove a job from the underlying scheduler by its UUID.
    pub async fn unschedule_automation(&self, job_id: Uuid) -> Result<(), String> {
        let guard = self.scheduler.read().await;
        let scheduler = guard.as_ref().ok_or("Scheduler not initialized")?;

        scheduler.remove(&job_id).await.map_err(
            |e| crate::localized_error!("backendErrors.automation.executionFailed", "error" => e),
        )?;

        debug!("Unscheduled job: {job_id}");
        Ok(())
    }

    /// Atomically replace an automation's scheduler job.
    pub async fn reschedule_automation(
        &self,
        automation: &Automation,
        cache: State<'_, AutomationsCache>,
    ) -> Result<(), String> {
        let automation_name = automation.log_name();
        if let Some(job_id_str) = &automation.scheduler_job_id
            && let Ok(job_id) = Uuid::parse_str(job_id_str)
        {
            match self.unschedule_automation(job_id).await {
                Ok(()) => info!("Removed old job {job_id} for '{automation_name}'"),
                Err(e) => warn!("Failed to remove old job {job_id}: {e}"),
            }
        }

        let is_active = automation.status == AutomationStatus::Enabled
            || automation.status == AutomationStatus::Failed;
        if is_active && automation.cron_expression.is_some() {
            info!("Scheduling active automation '{automation_name}'…");
            match self.schedule_automation(automation, cache.clone()).await {
                Ok(new_job_id) => {
                    info!("Rescheduled '{automation_name}' → job {new_job_id}");
                }
                Err(e) => {
                    error!("Failed to reschedule '{automation_name}': {e}");
                    cache
                        .update_automation(&automation.id, |t| t.mark_failure(e.clone()), None)
                        .await?;
                    return Err(e);
                }
            }
        } else {
            info!("Automation '{automation_name}' is disabled or realtime-only — clearing job ID.");
            cache
                .update_automation(
                    &automation.id,
                    |t| {
                        t.scheduler_job_id = None;
                    },
                    None,
                )
                .await
                .ok();
        }

        Ok(())
    }

    /// Reload all automations from the cache, rescheduling every one.
    pub async fn reload_automations(&self, app: AppHandle) -> Result<(), String> {
        info!("Reloading all scheduled automations…");
        let cache = app.state::<AutomationsCache>();

        let automations = cache.get_all_automations().await;
        info!("Found {} automation(s) to sync", automations.len());

        let mut errors: Vec<String> = Vec::new();
        for automation in automations {
            let automation_name = automation.log_name();
            if let Err(e) = self.reschedule_automation(&automation, cache.clone()).await {
                error!(
                    "Failed to reload '{}' ({}): {}",
                    automation_name, automation.id, e
                );
                errors.push(format!("{}: {}", automation.id, e));
            }
        }

        if errors.is_empty() {
            info!("Scheduler reload complete");
            Ok(())
        } else {
            Err(format!(
                "{} automation(s) failed to reload: {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    /// Apply a `CacheUpdateResult` to the live scheduler.
    pub async fn apply_cache_result(
        &self,
        result: &CacheUpdateResult,
        cache: State<'_, AutomationsCache>,
    ) -> Result<(), String> {
        for automation in &result.removed {
            if let Some(job_id_str) = &automation.scheduler_job_id
                && let Ok(job_id) = Uuid::parse_str(job_id_str)
                && let Err(e) = self.unschedule_automation(job_id).await
            {
                warn!(
                    "Failed to unschedule removed automation '{}': {}",
                    automation.id, e
                );
            }
        }

        let mut errors: Vec<String> = Vec::new();
        for automation in result.added.iter().chain(result.updated.iter()) {
            let automation_name = automation.log_name();
            if let Err(e) = self.reschedule_automation(automation, cache.clone()).await {
                error!(
                    "Failed to reschedule '{}' ({}): {}",
                    automation_name, automation.id, e
                );
                errors.push(format!("{}: {}", automation.id, e));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} automation(s) failed to reschedule: {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }
}

impl Default for AutomationScheduler {
    fn default() -> Self {
        Self::new()
    }
}

pub fn validate_cron_expression(cron_expr: &str) -> Result<(), String> {
    if cron_expr.split_whitespace().count() == 6 {
        return Err(
            crate::localized_error!("backendErrors.automation.invalidCron", "error" => "unexpected number of fields"),
        );
    }
    croner::parser::CronParser::new().parse(cron_expr).map_err(
        |e| crate::localized_error!("backendErrors.automation.invalidCron", "error" => e),
    )?;

    let cron_6_field = format!("0 {cron_expr}");
    JobBuilder::new()
        .with_cron_job_type()
        .with_schedule(&cron_6_field)
        .map_err(
            |e| crate::localized_error!("backendErrors.automation.invalidCron", "error" => e),
        )?;

    Ok(())
}

/// Calculate the next UTC fire time for a 5-field cron expression.
pub fn get_next_run(cron_expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    let cron = croner::parser::CronParser::new()
        .parse(cron_expr)
        .map_err(|e| format!("Invalid cron expression: {e}"))?;

    let next_local = cron.find_next_occurrence(&Local::now(), false).map_err(
        |e| crate::localized_error!("backendErrors.automation.executionFailed", "error" => e),
    )?;

    Ok(next_local.with_timezone(&Utc))
}

pub async fn execute_automation(automation_id: &str, app_handle: &AppHandle) -> Result<(), String> {
    let cache = app_handle.state::<AutomationsCache>();
    let automation = cache
        .get_automation(automation_id)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.automation.automationNotFound"))?;

    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();
    let job_cache = &backend_manager.job_cache;

    let remote_name = automation.args.params.remote_name.clone();
    let job_type = automation.automation_type.as_job_type();
    let profile = Some(automation.args.params.profile_name.as_str());

    let is_running = automation.status == AutomationStatus::Running
        || automation.status == AutomationStatus::Stopping
        || automation.current_job_id.is_some()
        || job_cache
            .is_job_running(&remote_name, job_type.clone(), profile)
            .await;

    if is_running {
        let automation_name = automation.log_name();
        warn!(
            "Skipping '{}': a '{}' job for '{}' (profile: {:?}) is already running (automation status: {:?}).",
            automation_name, job_type, remote_name, profile, automation.status
        );
        return Ok(());
    }

    if automation.status == AutomationStatus::Disabled {
        return Err(crate::localized_error!(
            "backendErrors.automation.automationCannotRun",
            "status" => format!("{:?}", automation.status)
        ));
    }

    cache
        .update_automation(
            automation_id,
            |t| {
                let _ = t.mark_starting();
            },
            Some(app_handle),
        )
        .await?;

    let params = automation.args.params.clone();

    let transfer_type = match automation.automation_type {
        AutomationType::Copy => TransferType::Copy,
        AutomationType::Sync => TransferType::Sync,
        AutomationType::Move => TransferType::Move,
        AutomationType::Bisync => TransferType::Bisync,
    };

    let mut params = params;
    params.source = Some(crate::utils::types::origin::Origin::Automation);
    let result = start_profile_batch(app_handle.clone(), transfer_type, params).await;

    match result {
        Ok(job_id) => {
            let next_run = get_run_expr_or_none(automation.cron_expression.as_deref());
            cache
                .update_automation(
                    automation_id,
                    |t| {
                        t.mark_running(job_id);
                        t.next_run = next_run;
                    },
                    Some(app_handle),
                )
                .await
                .ok();
            notify(
                app_handle,
                NotificationEvent::Automation(AutomationStage::Started {
                    backend: automation.backend_name.clone(),
                    remote: automation.remote_name.clone(),
                    profile: automation.profile_name.clone(),
                    automation_name: automation.display_name(),
                    automation_type: automation.automation_type,
                }),
            );
            Ok(())
        }
        Err(e) => {
            let next_run = get_run_expr_or_none(automation.cron_expression.as_deref());
            cache
                .update_automation(
                    automation_id,
                    |t| {
                        t.mark_failure(e.clone());
                        t.next_run = next_run;
                    },
                    Some(app_handle),
                )
                .await?;
            Err(e)
        }
    }
}

fn get_run_expr_or_none(cron_expr: Option<&str>) -> Option<chrono::DateTime<Utc>> {
    let expr = cron_expr?;
    get_next_run(expr).ok()
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    // -----------------------------------------------------------------------
    // validate_cron_expression
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_cron_valid_expressions() {
        assert!(validate_cron_expression("* * * * *").is_ok());
        assert!(validate_cron_expression("0 9 * * 1-5").is_ok());
        assert!(validate_cron_expression("*/15 * * * *").is_ok());
        assert!(validate_cron_expression("0 0 1 * *").is_ok());
        assert!(validate_cron_expression("30 6 * * 1,3,5").is_ok());
    }

    #[test]
    fn test_validate_cron_invalid_expressions() {
        assert!(validate_cron_expression("invalid").is_err());
        // 6 fields from the user is rejected (we add the seconds field ourselves)
        assert!(validate_cron_expression("* * * * * *").is_err());
        // Minute 60 is out of range
        assert!(validate_cron_expression("60 * * * *").is_err());
        // Empty string
        assert!(validate_cron_expression("").is_err());
    }

    // -----------------------------------------------------------------------
    // get_next_run
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_next_run_is_in_the_future() {
        let now = Utc::now();
        let next = get_next_run("* * * * *").unwrap();
        assert!(next > now, "next run must be after now");
    }

    #[test]
    fn test_get_next_run_specific_date() {
        // Jan 1st midnight — local time
        let next = get_next_run("0 0 1 1 *").unwrap();
        let local = next.with_timezone(&Local);
        assert_eq!(local.minute(), 0);
        assert_eq!(local.hour(), 0);
        assert_eq!(local.day(), 1);
        assert_eq!(local.month(), 1);
    }

    #[test]
    fn test_get_next_run_invalid_expression_returns_err() {
        assert!(get_next_run("not-valid").is_err());
        assert!(get_next_run("").is_err());
    }

    // -----------------------------------------------------------------------
    // validate_cron_expression — boundary values
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_cron_boundary_minutes() {
        // Minute 0 and 59 are valid
        assert!(validate_cron_expression("0 * * * *").is_ok());
        assert!(validate_cron_expression("59 * * * *").is_ok());
        // Minute 60 is invalid
        assert!(validate_cron_expression("60 * * * *").is_err());
    }

    #[test]
    fn test_validate_cron_step_values() {
        assert!(validate_cron_expression("*/5 * * * *").is_ok());
        assert!(validate_cron_expression("*/30 * * * *").is_ok());
    }

    #[test]
    fn test_validate_cron_ranges() {
        assert!(validate_cron_expression("0 9-17 * * *").is_ok());
        assert!(validate_cron_expression("0 0 * * 1-5").is_ok());
    }

    // -----------------------------------------------------------------------
    // AutomationScheduler construction (no async runtime needed)
    // -----------------------------------------------------------------------

    #[test]
    fn test_cron_scheduler_default() {
        let s = AutomationScheduler::default();
        // These must not panic
        let _ = Arc::clone(&s.scheduler);
        let _ = Arc::clone(&s.app_handle);
    }
}
