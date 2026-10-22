//! Cron scheduler engine using tokio-cron-scheduler

use crate::context::{AppHandle, State};
use crate::rclone::commands::sync::start_resolved_profile_batch;
use crate::rclone::state::automations::AutomationsCache;
use crate::utils::app::notification::{AutomationStage, NotificationEvent, notify};
use crate::utils::types::automation::{Automation, AutomationStatus};
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{JobBuilder, JobScheduler};
use uuid::Uuid;

struct SchedulerRuntime {
    scheduler: JobScheduler,
    app: AppHandle,
    started: bool,
}

pub struct AutomationScheduler {
    scheduler: RwLock<Option<SchedulerRuntime>>,
    installed: tokio::sync::Mutex<std::collections::HashMap<String, (Uuid, String)>>,
}

impl AutomationScheduler {
    pub fn new() -> Self {
        Self {
            scheduler: RwLock::new(None),
            installed: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Reuse the existing scheduler and its installed jobs on startup retries.
    pub async fn initialize(&self, app_handle: AppHandle) -> Result<(), String> {
        let mut guard = self.scheduler.write().await;
        if guard.is_some() {
            return Ok(());
        }
        info!("Initializing cron scheduler...");

        let scheduler = JobScheduler::new().await.map_err(
            |e| crate::localized_error!("backendErrors.automation.initFailed", "error" => e),
        )?;

        *guard = Some(SchedulerRuntime {
            scheduler,
            app: app_handle,
            started: false,
        });

        info!("Cron scheduler initialized");
        Ok(())
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut guard = self.scheduler.write().await;
        let runtime = guard.as_mut().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.automation.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        if runtime.started {
            return Ok(());
        }
        runtime.scheduler.start().await.map_err(
            |e| crate::localized_error!("backendErrors.automation.startFailed", "error" => e),
        )?;

        runtime.started = true;
        info!("Cron scheduler started");
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        // Reconciliation takes these locks in the same order.
        let mut installed = self.installed.lock().await;
        let mut guard = self.scheduler.write().await;
        let Some(runtime) = guard.as_mut() else {
            return Ok(());
        };

        runtime.scheduler.shutdown().await.map_err(
            |e| crate::localized_error!("backendErrors.automation.stopFailed", "error" => e),
        )?;

        *guard = None;
        installed.clear();
        info!("Cron scheduler stopped");
        Ok(())
    }

    /// Schedule an automation and return the new scheduler job UUID.
    async fn schedule_automation(&self, automation: &Automation) -> Result<Uuid, String> {
        if matches!(
            automation.status,
            AutomationStatus::Disabled | AutomationStatus::Stopping
        ) {
            return Err(crate::localized_error!(
                "backendErrors.automation.automationNotEnabled"
            ));
        }

        let scheduler_guard = self.scheduler.read().await;
        let runtime = scheduler_guard.as_ref().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.automation.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        let app_handle = runtime.app.clone();

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

                    if let Err(e) = execute_automation(&automation_id, &app_handle, None).await {
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

        let job_id = runtime.scheduler.add(job).await.map_err(
            |e| crate::localized_error!("backendErrors.automation.executionFailed", "error" => e),
        )?;

        let automation_name = automation.log_name();
        info!("Scheduled '{automation_name}' ({cron_expr_6_field}) — job ID: {job_id}");

        Ok(job_id)
    }

    async fn remove_job(&self, id: Uuid) -> Result<(), String> {
        let guard = self.scheduler.read().await;
        let runtime = guard.as_ref().ok_or("Scheduler not initialized")?;
        runtime.scheduler.remove(&id).await.map_err(|error| crate::localized_error!("backendErrors.automation.executionFailed", "error" => error))
    }

    pub async fn unschedule_automation(&self, id: Uuid) -> Result<(), String> {
        let mut installed = self.installed.lock().await;
        self.remove_job(id).await?;
        installed.retain(|_, (job, _)| *job != id);
        Ok(())
    }

    pub async fn reschedule_automation(
        &self,
        automation_id: &str,
        cache: State<AutomationsCache>,
    ) -> Result<(), String> {
        let mut installed = self.installed.lock().await;
        let Some(automation) = cache.get_automation(automation_id).await else {
            return Ok(());
        };
        let app = self
            .scheduler
            .read()
            .await
            .as_ref()
            .ok_or("Scheduler not initialized")?
            .app
            .clone();
        let backend = app
            .state::<crate::rclone::backend::BackendManager>()
            .get_active_name()
            .await;
        let previous = installed.get(&automation.id).cloned();
        let desired = automation
            .cron_expression
            .as_deref()
            .filter(|_| automation.should_schedule(&backend));
        if previous.as_ref().map(|(_, expression)| expression.as_str()) == desired {
            let id = previous.map(|(id, _)| id.to_string());
            if automation.scheduler_job_id != id {
                cache
                    .update_automation(&automation.id, |automation| {
                        automation.scheduler_job_id = id
                    })
                    .await?;
            }
            return Ok(());
        }
        // Build and install the replacement while the old schedule still exists.
        // A malformed expression or failed add leaves the previous job intact.
        let replacement = if desired.is_some() {
            Some(self.schedule_automation(&automation).await?)
        } else {
            None
        };
        if let Some((old_id, _)) = previous
            && let Err(error) = self.remove_job(old_id).await
        {
            if let Some(new_id) = replacement
                && let Err(rollback) = self.remove_job(new_id).await
            {
                error!("Failed to remove replacement cron {new_id}: {rollback}");
            }
            return Err(error);
        }
        if let Some(id) = replacement {
            installed.insert(automation.id.clone(), (id, desired.unwrap().to_string()));
        } else {
            installed.remove(&automation.id);
        }
        cache
            .update_automation(&automation.id, |automation| {
                automation.scheduler_job_id = replacement.map(|id| id.to_string())
            })
            .await?;
        Ok(())
    }

    /// Reconcile desired settings against actual installed jobs on every call.
    /// Failed removals stay in `installed` and are retried even after cache deletion.
    pub async fn reload_automations(&self, app: AppHandle) -> Result<(), String> {
        let cache = app.state::<AutomationsCache>();
        let automations = cache.get_all_automations().await;
        let ids: std::collections::HashSet<_> = automations
            .iter()
            .map(|automation| automation.id.as_str())
            .collect();
        let removed: Vec<_> = self
            .installed
            .lock()
            .await
            .iter()
            .filter(|(id, _)| !ids.contains(id.as_str()))
            .map(|(_, (id, _))| *id)
            .collect();
        let mut errors = Vec::new();
        for id in removed {
            if let Err(error) = self.unschedule_automation(id).await {
                errors.push(error);
            }
        }
        for automation in automations {
            if let Err(error) = self
                .reschedule_automation(&automation.id, cache.clone())
                .await
            {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(
                crate::localized_error!("backendErrors.automation.executionFailed", "error" => errors.join("; ")),
            )
        }
    }
}

impl Default for AutomationScheduler {
    fn default() -> Self {
        Self::new()
    }
}

/// Reconcile prepared automations with the scheduler, watchers, and system tray.
pub async fn apply_and_sync_automations(app: &AppHandle) -> Result<(), String> {
    let scheduler = app.state::<AutomationScheduler>();
    let watcher = app.state::<crate::services::automation::watcher::WatcherManager>();
    let schedule_result = scheduler.reload_automations(app.clone()).await;
    let watch_result = watcher.sync_watchers(app.clone()).await;
    crate::services::bridge::emit(crate::utils::types::events::UPDATE_TRAY_MENU, ());
    schedule_result.and(watch_result)
}

pub fn validate_enabled_cron(enabled: bool, expression: Option<&str>) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    let expression = expression.filter(|value| !value.trim().is_empty()).ok_or_else(|| crate::localized_error!("backendErrors.automation.invalidCron", "error" => "Cron expression is required"))?;
    validate_cron_expression(expression)
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

pub struct WatchTrigger {
    pub args: crate::utils::types::automation::AutomationArgs,
    pub changed_paths: std::collections::HashSet<std::path::PathBuf>,
}

pub async fn execute_automation(
    automation_id: &str,
    app_handle: &AppHandle,
    watch: Option<WatchTrigger>,
) -> Result<bool, String> {
    let backend_state = app_handle.state::<crate::rclone::backend::BackendManager>();
    let selection = backend_state.switch_lock.lock().await;
    let cache = app_handle.state::<AutomationsCache>();
    let automation = cache
        .get_automation(automation_id)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.automation.automationNotFound"))?;

    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    if !automation.belongs_to_backend(&backend.name) {
        debug!("Skipping automation '{automation_id}': its backend is not selected");
        return Ok(false);
    }
    let job_cache = backend_manager.job_cache_for(&backend.name);

    let remote_name = automation.args.params.remote_name.clone();
    let job_type = automation.automation_type.as_job_type().unwrap();
    let profile = Some(automation.args.params.profile_name.as_str());

    if job_cache
        .is_job_running(&remote_name, job_type.clone(), profile)
        .await
    {
        let automation_name = automation.log_name();
        warn!(
            "Skipping '{}': a '{}' job for '{}' (profile: {:?}) is already running (automation status: {:?}).",
            automation_name, job_type, remote_name, profile, automation.status
        );
        return Ok(false);
    }

    let Some(automation) = cache
        .try_start_automation(
            automation_id,
            &backend.name,
            watch.as_ref().map(|trigger| &trigger.args),
        )
        .await?
    else {
        debug!("Skipping automation '{automation_id}': execution permission was not granted");
        return Ok(false);
    };

    let execution_id = automation
        .execution_id
        .clone()
        .expect("start reserves an execution identity");
    let mut selection = Some(selection);
    if automation.is_global() {
        drop(selection.take());
    }
    enum AutomationExecutionOutcome {
        Running(String),
        Success,
    }

    let next_run = get_run_expr_or_none(automation.cron_expression.as_deref());

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

    let execution_result: Result<AutomationExecutionOutcome, String> =
        match automation.args.params.source {
            Some(crate::utils::types::origin::Origin::QuickRun) => {
                let qr_id = &automation.id;
                info!("Executing quick run automation: {qr_id}");
                crate::services::flow::quick_run::commands::start_quick_run_on_backend(
                    app_handle.clone(),
                    backend.clone(),
                    qr_id.to_string(),
                    None,
                    None,
                    Some(execution_id.clone()),
                )
                .await
                .map(|res| {
                    let job_handle = res
                        .job_id
                        .map(|id| id.to_string())
                        .unwrap_or_else(|| res.execute_id);
                    AutomationExecutionOutcome::Running(job_handle)
                })
            }
            Some(crate::utils::types::origin::Origin::Flow) => {
                let wf_id = &automation.id;
                info!("Executing workflow automation: {wf_id}");
                let _ = cache
                    .update_automation(automation_id, |t| {
                        if t.execution_id.as_deref() == Some(&execution_id) {
                            t.current_job_id = Some(wf_id.clone());
                        }
                        t.next_run = next_run;
                    })
                    .await;

                // execute_workflow emits its own dedicated NotificationEvent::Workflow events
                crate::services::flow::workflow::engine::execute_workflow(
                    app_handle.clone(),
                    backend.clone(),
                    wf_id.to_string(),
                    false,
                )
                .await
                .and_then(|exec_res| {
                    if exec_res.success {
                        Ok(AutomationExecutionOutcome::Success)
                    } else {
                        Err(exec_res
                            .error
                            .unwrap_or_else(|| "Workflow execution failed".to_string()))
                    }
                })
            }
            _ => {
                let mut params = automation.args.params.clone();
                params.source = Some(crate::utils::types::origin::Origin::Automation);
                params.scoped_targets = if automation.watch_changed_only
                    && automation.automation_type
                        != crate::utils::types::remotes::OperationType::Bisync
                {
                    watch.as_ref().map(|trigger| {
                        crate::services::automation::watcher::compute_scoped_targets(
                            &automation.args.src_paths,
                            &automation.args.dst_paths,
                            &trigger.changed_paths,
                        )
                    })
                } else {
                    None
                };
                params.backend_name = Some(automation.backend_name.clone());
                params.execute_id = Some(execution_id.clone());

                let transfer_type = automation.automation_type;
                let mut resolved = if app_handle
                    .state::<crate::services::settings::AppSettingsManager>()
                    .is_locked()
                {
                    super::runtime::profile(app_handle, automation_id, &backend)
                } else {
                    crate::rclone::commands::common::resolve_profile_settings(
                        app_handle,
                        &params.remote_name,
                        &params.profile_name,
                        transfer_type,
                        params.backend_name.as_deref(),
                    )
                    .await
                };
                // Auto-lock may happen during the asynchronous backend lookup.
                if resolved.is_err()
                    && app_handle
                        .state::<crate::services::settings::AppSettingsManager>()
                        .is_locked()
                {
                    resolved = super::runtime::profile(app_handle, automation_id, &backend);
                }
                // Execute an immutable profile snapshot without holding the
                // selection/settings lock through a long remote operation.
                drop(selection.take());
                match resolved {
                    Ok(resolved) => start_resolved_profile_batch(
                        app_handle.clone(),
                        resolved,
                        transfer_type,
                        params,
                    )
                    .await
                    .map(AutomationExecutionOutcome::Running),
                    Err(error) => Err(error),
                }
            }
        };

    match execution_result {
        Ok(AutomationExecutionOutcome::Running(job_handle)) => {
            cache
                .update_automation(automation_id, |t| {
                    if t.execution_id.as_deref() == Some(&execution_id) {
                        t.current_job_id = Some(job_handle);
                        t.next_run = next_run;
                    }
                })
                .await
                .ok();
            Ok(true)
        }
        Ok(AutomationExecutionOutcome::Success) => {
            cache
                .update_automation(automation_id, |t| {
                    if t.execution_id.as_deref() == Some(&execution_id) {
                        t.mark_success();
                        t.next_run = next_run;
                    }
                })
                .await
                .ok();
            Ok(true)
        }
        Err(e) => {
            cache
                .update_automation(automation_id, |t| {
                    if t.execution_id.as_deref() == Some(&execution_id) {
                        t.mark_failure(e.clone());
                        t.next_run = next_run;
                    }
                })
                .await
                .ok();
            Err(e)
        }
    }
}

fn get_run_expr_or_none(cron_expr: Option<&str>) -> Option<chrono::DateTime<Utc>> {
    let expr = cron_expr?;
    get_next_run(expr).ok()
}

// TESTS

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    #[test]
    fn enabled_cron_requires_a_valid_expression() {
        for expression in [None, Some(""), Some("   "), Some("invalid")] {
            assert!(validate_enabled_cron(true, expression).is_err());
        }
        assert!(validate_enabled_cron(false, None).is_ok());
        assert!(validate_enabled_cron(false, Some("invalid")).is_ok());
        assert!(validate_enabled_cron(true, Some("0 2 * * *")).is_ok());
    }

    #[tokio::test]
    async fn backend_reconciliation_preserves_running_cron_and_suspends_other_backends() {
        use crate::rclone::backend::{BackendManager, types::Backend};
        use crate::services::settings::{AppSettingsManager, schema::AppSettings};
        use crate::utils::constants::LOCAL_BACKEND_NAME;
        use crate::utils::types::remotes::RemoteSettings;

        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager =
            rcman::SettingsManager::builder("scheduler-test", "1.0.0")
                .with_config_dir(directory.path())
                .with_schema::<AppSettings>()
                .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
                .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
                .build()
                .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Other", "127.0.0.1", 0),
                None,
                None,
            )
            .await
            .unwrap();

        let remote: RemoteSettings = serde_json::from_value(serde_json::json!({
            "syncConfigs": { "Default": {
                "rclone": {"srcFs": "/src", "dstFs": "/dst"},
                "app": {"cronEnabled": true, "cronExpression": "0 0 1 1 *"}
            } }
        }))
        .unwrap();
        let remotes = std::collections::HashMap::from([("drive".to_string(), remote)]);
        let cache = AutomationsCache::new();
        let local = cache
            .load_from_remote_configs(&remotes, LOCAL_BACKEND_NAME)
            .await
            .unwrap()
            .added
            .remove(0);
        let other = cache
            .load_from_remote_configs(&remotes, "Other")
            .await
            .unwrap()
            .added
            .remove(0);
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(cache);
        let cache = app.state::<AutomationsCache>();
        let scheduler = AutomationScheduler::new();
        scheduler.initialize(app.clone()).await.unwrap();
        scheduler.start().await.unwrap();

        scheduler.reload_automations(app.clone()).await.unwrap();
        let local_cron = cache
            .get_automation(&local.id)
            .await
            .unwrap()
            .scheduler_job_id
            .unwrap();
        // A startup retry must keep the live scheduler that owns this job ID.
        let (first, second) = tokio::join!(
            scheduler.initialize(app.clone()),
            scheduler.initialize(app.clone()),
        );
        first.unwrap();
        second.unwrap();
        scheduler.start().await.unwrap();
        scheduler.reload_automations(app.clone()).await.unwrap();
        assert_eq!(
            scheduler
                .installed
                .lock()
                .await
                .get(&local.id)
                .unwrap()
                .0
                .to_string(),
            local_cron
        );
        assert!(
            cache
                .get_automation(&other.id)
                .await
                .unwrap()
                .scheduler_job_id
                .is_none()
        );
        cache
            .update_automation(&local.id, |a| {
                a.mark_starting().unwrap();
                a.current_job_id = Some("7".to_string());
            })
            .await
            .unwrap();
        scheduler.reload_automations(app.clone()).await.unwrap();
        assert_eq!(
            cache
                .get_automation(&local.id)
                .await
                .unwrap()
                .scheduler_job_id
                .as_deref(),
            Some(local_cron.as_str())
        );

        cache
            .update_automation(&local.id, |automation| {
                automation.cron_expression = Some("invalid".to_string())
            })
            .await
            .unwrap();
        assert!(scheduler.reload_automations(app.clone()).await.is_err());
        assert_eq!(
            cache
                .get_automation(&local.id)
                .await
                .unwrap()
                .scheduler_job_id
                .as_deref(),
            Some(local_cron.as_str())
        );
        cache
            .update_automation(&local.id, |automation| {
                automation.cron_expression = Some("0 0 1 1 *".to_string())
            })
            .await
            .unwrap();
        scheduler.reload_automations(app.clone()).await.unwrap();
        let manager = app.state::<BackendManager>();
        manager.switch_to(&settings, "Other").await.unwrap();
        scheduler.reload_automations(app.clone()).await.unwrap();
        let running = cache.get_automation(&local.id).await.unwrap();
        assert!(running.scheduler_job_id.is_none());
        assert_eq!(running.current_job_id.as_deref(), Some("7"));
        assert_eq!(running.status, AutomationStatus::Running);
        assert!(
            cache
                .get_automation(&other.id)
                .await
                .unwrap()
                .scheduler_job_id
                .is_some()
        );

        manager
            .switch_to(&settings, LOCAL_BACKEND_NAME)
            .await
            .unwrap();
        scheduler.reload_automations(app.clone()).await.unwrap();
        assert!(
            cache
                .get_automation(&local.id)
                .await
                .unwrap()
                .scheduler_job_id
                .is_some()
        );
        assert!(
            cache
                .get_automation(&other.id)
                .await
                .unwrap()
                .scheduler_job_id
                .is_none()
        );
        scheduler.stop().await.unwrap();
        assert!(scheduler.installed.lock().await.is_empty());
    }

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

    #[tokio::test]
    async fn scheduler_can_stop_before_initialization_and_start_again_after_shutdown() {
        let s = AutomationScheduler::default();
        s.stop().await.unwrap();
        assert!(s.start().await.is_err());
        s.initialize(AppHandle::default()).await.unwrap();
        s.start().await.unwrap();
        s.start().await.unwrap();
        s.stop().await.unwrap();
        assert!(s.scheduler.read().await.is_none());
        assert!(s.installed.lock().await.is_empty());
        s.initialize(AppHandle::default()).await.unwrap();
        s.start().await.unwrap();
        s.stop().await.unwrap();
    }
}
