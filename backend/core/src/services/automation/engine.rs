//! Cron scheduler engine using tokio-cron-scheduler

use crate::context::{AppHandle, State};
use crate::rclone::backend::{BackendManager, types::Backend};
use crate::rclone::commands::job_parser::JobOutcome;
use crate::rclone::commands::sync::start_resolved_profile_batch;
use crate::rclone::state::automations::AutomationsCache;
use crate::services::settings::AppSettingsManager;
use crate::utils::app::notification::{AutomationStage, NotificationEvent, notify};
use crate::utils::cron::get_next_run;
use crate::utils::types::automation::{Automation, AutomationStatus};
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::OperationType;
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{JobBuilder, JobScheduler};
use uuid::Uuid;

fn scheduler_not_initialized() -> String {
    crate::localized_error!("backendErrors.automation.schedulerNotInitialized")
}

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
        let runtime = guard.as_mut().ok_or_else(scheduler_not_initialized)?;

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
        let runtime = scheduler_guard
            .as_ref()
            .ok_or_else(scheduler_not_initialized)?;

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
            .ok_or_else(|| crate::localized_error!("backendErrors.automation.noCronExpression"))?;
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
        let runtime = guard.as_ref().ok_or_else(scheduler_not_initialized)?;
        runtime.scheduler.remove(&id).await.map_err(|error| crate::localized_error!("backendErrors.automation.executionFailed", "error" => error))
    }

    /// The cron job installed for an automation.
    #[cfg(test)]
    pub(crate) async fn scheduled_job(&self, automation_id: &str) -> Option<Uuid> {
        let installed = self.installed.lock().await;
        installed.get(automation_id).map(|(job, _)| *job)
    }

    /// Removes the automation's cron job. A failed removal keeps the entry, so a later
    /// reconciliation retries it.
    pub async fn unschedule_automation(&self, automation_id: &str) -> Result<(), String> {
        let mut installed = self.installed.lock().await;
        let Some((job, _)) = installed.get(automation_id).cloned() else {
            return Ok(());
        };
        self.remove_job(job).await?;
        installed.remove(automation_id);
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
            .ok_or_else(scheduler_not_initialized)?
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
        match (replacement, desired) {
            (Some(id), Some(expression)) => {
                installed.insert(automation.id.clone(), (id, expression.to_string()));
            }
            _ => {
                installed.remove(&automation.id);
            }
        }
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
        let removed: Vec<String> = self
            .installed
            .lock()
            .await
            .keys()
            .filter(|id| !ids.contains(id.as_str()))
            .cloned()
            .collect();
        let mut errors = Vec::new();
        for id in removed {
            if let Err(error) = self.unschedule_automation(&id).await {
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

pub struct WatchTrigger {
    pub args: crate::utils::types::automation::AutomationArgs,
    pub changed_paths: std::collections::HashSet<std::path::PathBuf>,
}

enum AutomationExecutionOutcome {
    Running(String),
    Success,
}

pub async fn execute_automation(
    automation_id: &str,
    app_handle: &AppHandle,
    watch: Option<WatchTrigger>,
) -> Result<bool, String> {
    let backend_manager = app_handle.state::<BackendManager>();
    let selection = backend_manager.switch_lock.lock().await;
    let cache = app_handle.state::<AutomationsCache>();
    let automation = cache
        .get_automation(automation_id)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.automation.automationNotFound"))?;

    let backend = backend_manager.get_active().await;
    if !automation.belongs_to_backend(&backend.name) {
        debug!("Skipping automation '{automation_id}': its backend is not selected");
        return Ok(false);
    }

    // A serve quick run starts a serve, not a job, so there is no job to collide with.
    if let Some(job_type) = automation.automation_type.as_job_type() {
        let remote_name = &automation.args.params.remote_name;
        let profile = Some(automation.args.params.profile_name.as_str());
        let activity = backend_manager
            .job_cache_for(&backend.name)
            .job_activity(remote_name, &job_type, profile)
            .await;
        if activity.running {
            warn!(
                "Skipping '{}': a '{job_type}' job for '{remote_name}' (profile: {profile:?}) is already running (automation status: {:?}).",
                automation.log_name(),
                automation.status
            );
            return Ok(false);
        }
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
    let Some(execution_id) = automation.execution_id.clone() else {
        debug!("Skipping automation '{automation_id}': it started without an execution identity");
        return Ok(false);
    };

    let mut selection = Some(selection);
    if automation.is_global() {
        drop(selection.take());
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

    let execution = match automation.args.params.source {
        Some(Origin::QuickRun) => {
            run_quick_run(app_handle, &backend, &automation, &execution_id).await
        }
        Some(Origin::Flow) => {
            let watched = watch.is_some();
            run_workflow(
                app_handle,
                &backend,
                &cache,
                &automation,
                &execution_id,
                next_run,
                watched,
            )
            .await
        }
        _ => {
            run_profile(
                app_handle,
                &backend,
                &automation,
                &execution_id,
                watch.as_ref(),
                &mut selection,
            )
            .await
        }
    };
    finish_execution(&cache, automation_id, &execution_id, next_run, execution).await
}

async fn run_quick_run(
    app: &AppHandle,
    backend: &Backend,
    automation: &Automation,
    execution_id: &str,
) -> Result<AutomationExecutionOutcome, String> {
    info!("Executing quick run automation: {}", automation.id);
    let started = crate::services::flow::quick_run::commands::start_quick_run_on_backend(
        app.clone(),
        backend.clone(),
        automation.id.clone(),
        None,
        None,
        Some(execution_id.to_owned()),
    )
    .await?;
    // A serve is a running resource, not a job, so nothing would ever finish this execution.
    if started.serve_id.is_some() {
        return Ok(AutomationExecutionOutcome::Success);
    }
    let handle = started
        .job_id
        .map_or(started.execute_id, |id| id.to_string());
    Ok(AutomationExecutionOutcome::Running(handle))
}

async fn run_workflow(
    app: &AppHandle,
    backend: &Backend,
    cache: &AutomationsCache,
    automation: &Automation,
    execution_id: &str,
    next_run: Option<chrono::DateTime<Utc>>,
    watched: bool,
) -> Result<AutomationExecutionOutcome, String> {
    use crate::services::flow::workflow::engine::{RunTrigger, execute_workflow};

    info!("Executing workflow automation: {}", automation.id);
    let _ = cache
        .update_automation(&automation.id, |t| {
            if t.execution_id.as_deref() == Some(execution_id) {
                t.current_job_id = Some(automation.id.clone());
            }
            t.next_run = next_run;
        })
        .await;

    // execute_workflow emits its own dedicated NotificationEvent::Workflow events
    let trigger = if watched {
        RunTrigger::Watcher
    } else {
        RunTrigger::Cron
    };
    let result = execute_workflow(
        app.clone(),
        backend.clone(),
        automation.id.clone(),
        false,
        trigger,
    )
    .await?;
    if result.success {
        Ok(AutomationExecutionOutcome::Success)
    } else {
        Err(result
            .error
            .unwrap_or_else(|| crate::localized_error!("backendErrors.workflow.unknownError")))
    }
}

async fn run_profile(
    app: &AppHandle,
    backend: &Backend,
    automation: &Automation,
    execution_id: &str,
    watch: Option<&WatchTrigger>,
    selection: &mut Option<tokio::sync::MutexGuard<'_, ()>>,
) -> Result<AutomationExecutionOutcome, String> {
    let transfer_type = automation.automation_type;
    let mut params = automation.args.params.clone();
    params.source = Some(Origin::Automation);
    params.scoped_targets = match watch {
        Some(trigger)
            if automation.watch_changed_only && transfer_type != OperationType::Bisync =>
        {
            // Telling files from directories asks the file system about every changed path.
            let (src, dst, changed) = (
                automation.args.src_paths.clone(),
                automation.args.dst_paths.clone(),
                trigger.changed_paths.clone(),
            );
            let targets = crate::utils::spawn_blocking(move || {
                crate::services::automation::watcher::compute_scoped_targets(&src, &dst, &changed)
            })
            .await
            .map_err(|error| error.to_string())?;
            Some(targets)
        }
        _ => None,
    };
    params.backend_name = Some(automation.backend_name.clone());
    params.execute_id = Some(execution_id.to_owned());

    let settings = app.state::<AppSettingsManager>();
    let mut resolved = if settings.is_locked() {
        super::runtime::profile(app, &automation.id, backend)
    } else {
        crate::rclone::commands::common::resolve_profile_settings(
            app,
            &params.remote_name,
            &params.profile_name,
            transfer_type,
            params.backend_name.as_deref(),
        )
        .await
    };
    // Auto-lock may happen during the asynchronous backend lookup.
    if resolved.is_err() && settings.is_locked() {
        resolved = super::runtime::profile(app, &automation.id, backend);
    }
    // Execute an immutable profile snapshot without holding the
    // selection/settings lock through a long remote operation.
    drop(selection.take());
    start_resolved_profile_batch(app.clone(), resolved?, transfer_type, params)
        .await
        .map(AutomationExecutionOutcome::Running)
}

/// Records how a started execution ended, unless a newer execution replaced it.
async fn finish_execution(
    cache: &AutomationsCache,
    automation_id: &str,
    execution_id: &str,
    next_run: Option<chrono::DateTime<Utc>>,
    execution: Result<AutomationExecutionOutcome, String>,
) -> Result<bool, String> {
    let _ = cache
        .update_automation(automation_id, |automation| {
            if automation.execution_id.as_deref() != Some(execution_id) {
                return;
            }
            match &execution {
                Ok(AutomationExecutionOutcome::Running(job)) => {
                    // A job that already bound itself (the last of a chain) is the newer handle.
                    automation.current_job_id.get_or_insert_with(|| job.clone());
                }
                Ok(AutomationExecutionOutcome::Success) => automation.mark_success(),
                Err(error) => automation.mark_failure(error.clone()),
            }
            automation.next_run = next_run;
        })
        .await;
    execution.map(|_| true)
}

/// A job an automation started has ended: records the outcome, sets the next cron run and
/// announces the result.
pub(crate) async fn finish_job_execution(
    app: &AppHandle,
    backend_name: &str,
    execute_id: Option<&str>,
    outcome: &JobOutcome,
) {
    let Some(execute_id) = execute_id else {
        return;
    };
    let Some(automation) = app
        .state::<AutomationsCache>()
        .update_execution(backend_name, execute_id, |automation| {
            if outcome.success {
                automation.mark_success();
            } else if outcome.stopped {
                automation.mark_stopped();
            } else {
                automation.mark_failure(outcome.error_msg.clone().unwrap_or_default());
            }
            automation.next_run = get_run_expr_or_none(automation.cron_expression.as_deref());
        })
        .await
    else {
        return;
    };
    let event = if outcome.success {
        AutomationStage::Completed {
            backend: automation.backend_name.clone(),
            remote: automation.remote_name.clone(),
            profile: automation.profile_name.clone(),
            automation_name: automation.display_name(),
            automation_type: automation.automation_type,
        }
    } else if outcome.stopped {
        AutomationStage::Stopped {
            backend: automation.backend_name.clone(),
            remote: automation.remote_name.clone(),
            profile: automation.profile_name.clone(),
            automation_name: automation.display_name(),
            automation_type: automation.automation_type,
        }
    } else {
        AutomationStage::Failed {
            backend: automation.backend_name.clone(),
            remote: automation.remote_name.clone(),
            profile: automation.profile_name.clone(),
            automation_name: automation.display_name(),
            automation_type: automation.automation_type,
            error: outcome.error_msg.clone().unwrap_or_default(),
        }
    };
    notify(app, NotificationEvent::Automation(event));
}

fn get_run_expr_or_none(cron_expr: Option<&str>) -> Option<chrono::DateTime<Utc>> {
    let expr = cron_expr?;
    get_next_run(expr).ok()
}

// TESTS

#[cfg(test)]
mod tests {
    use super::*;
    async fn scheduled(scheduler: &AutomationScheduler, id: &str) -> Option<String> {
        scheduler.scheduled_job(id).await.map(|job| job.to_string())
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
                .with_sub_settings(
                    rcman::SubSettingsConfig::singlefile("quick_runs").with_profiles(),
                )
                .with_sub_settings(
                    rcman::SubSettingsConfig::singlefile("workflows").with_profiles(),
                )
                .build()
                .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("Other", "127.0.0.1", 0),
                crate::rclone::backend::CopySources::default(),
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
        let local_cron = scheduled(&scheduler, &local.id).await.unwrap();
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
        assert!(scheduled(&scheduler, &other.id).await.is_none());
        cache
            .update_automation(&local.id, |a| {
                a.mark_starting().unwrap();
                a.current_job_id = Some("7".to_string());
            })
            .await
            .unwrap();
        scheduler.reload_automations(app.clone()).await.unwrap();
        assert_eq!(
            scheduled(&scheduler, &local.id).await.as_deref(),
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
            scheduled(&scheduler, &local.id).await.as_deref(),
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
        assert!(scheduled(&scheduler, &local.id).await.is_none());
        assert_eq!(running.current_job_id.as_deref(), Some("7"));
        assert_eq!(running.status, AutomationStatus::Running);
        assert!(scheduled(&scheduler, &other.id).await.is_some());

        manager
            .switch_to(&settings, LOCAL_BACKEND_NAME)
            .await
            .unwrap();
        scheduler.reload_automations(app.clone()).await.unwrap();
        assert!(scheduled(&scheduler, &local.id).await.is_some());
        assert!(scheduled(&scheduler, &other.id).await.is_none());
        scheduler.stop().await.unwrap();
        assert!(scheduler.installed.lock().await.is_empty());
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
