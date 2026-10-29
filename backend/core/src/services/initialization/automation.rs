use crate::context::AppHandle;
use log::info;
use std::sync::Arc;

use crate::{
    rclone::{
        backend::{BackendManager, types::Backend},
        state::automations::AutomationsCache,
    },
    services::{
        automation::{
            engine::AutomationScheduler,
            runtime::{RuntimeTasks, WorkflowSnapshot},
        },
        flow::{quick_run::types::QuickRun, workflow::types::WorkflowDefinition},
        settings::AppSettingsManager,
    },
};

enum AutostartTask {
    QuickRun(QuickRun),
    Workflow(Arc<WorkflowSnapshot>),
}

/// Pending executions own their inputs so a vault lock after dispatch does not
/// force them to read settings again. Dropping a failed startup drops this plan.
pub(super) struct AutostartTasks {
    backend: Backend,
    tasks: Vec<AutostartTask>,
}

impl AutostartTasks {
    fn prepare(
        backend: Backend,
        manager: &AppSettingsManager,
        quick_runs: &[QuickRun],
        workflows: &[WorkflowDefinition],
    ) -> Result<Self, String> {
        let mut tasks: Vec<_> = quick_runs
            .iter()
            .filter(|quick_run| quick_run.is_autostart())
            .cloned()
            .map(AutostartTask::QuickRun)
            .collect();
        for workflow in workflows.iter().filter(|workflow| workflow.is_autostart()) {
            tasks.push(AutostartTask::Workflow(Arc::new(
                WorkflowSnapshot::capture(manager, workflow.clone())?,
            )));
        }
        Ok(Self { backend, tasks })
    }

    pub(super) fn start(self, app: &AppHandle) {
        for task in self.tasks {
            let backend = self.backend.clone();
            let delay = match &task {
                AutostartTask::QuickRun(quick_run) => quick_run.autostart_delay_secs(),
                AutostartTask::Workflow(_) => 0,
            };
            let task_app = app.clone();
            crate::services::lifecycle::startup::spawn_auto_start(app, delay, async move {
                let app = task_app;
                match task {
                    AutostartTask::QuickRun(quick_run) => {
                        let id = quick_run.id.clone();
                        info!("Auto-starting Quick Run: {id}");
                        if let Err(error) =
                            crate::services::flow::quick_run::commands::start_quick_run_snapshot(
                                app, backend, quick_run, None, None, None,
                            )
                            .await
                        {
                            log::error!("Failed to auto-start Quick Run {id}: {error}");
                        }
                    }
                    AutostartTask::Workflow(workflow) => {
                        let id = workflow.definition.id.clone();
                        info!("Auto-starting Workflow: {id}");
                        if let Err(error) =
                            crate::services::flow::workflow::engine::execute_workflow_snapshot(
                                app, backend, workflow, false,
                            )
                            .await
                        {
                            log::error!("Failed to auto-start Workflow {id}: {error}");
                        }
                    }
                }
            });
        }
    }
}

/// Prepare task inputs and reconcile the scheduler without launching autostarts.
pub(super) async fn initialize_automations(
    app_handle: AppHandle,
) -> Result<AutostartTasks, String> {
    let cache_state = app_handle.state::<AutomationsCache>();
    let scheduler_state = app_handle.state::<AutomationScheduler>();
    let manager = app_handle.state::<AppSettingsManager>();
    let revision = app_handle.state::<RuntimeTasks>().revision();

    let backend_manager = app_handle.state::<BackendManager>();
    let _selection = backend_manager.switch_lock.lock().await;
    let (backend, all_settings) = backend_manager.active_remote_configs(manager.inner()).await;

    info!("📋 Loading automations from remote configs...");

    let backend_name = backend.name.clone();
    let quick_runs = crate::services::flow::quick_run::commands::get_all_quick_runs_sync(&manager)?;
    let workflows = crate::services::flow::workflow::commands::get_all_workflows_sync(&manager)?;

    let result = cache_state
        .load_from_remote_configs(&all_settings, &backend_name)
        .await?;

    info!("📅 Loaded {} remote automation(s)", result.added.len());

    // ── Quick Run Automations ───────────────────────────────────────────────
    info!("🚀 Syncing {} Quick Run(s)...", quick_runs.len());

    cache_state
        .load_from_quick_runs(&quick_runs, &backend_name)
        .await?;

    // ── Workflow Automations ───────────────────────────────────────────────
    info!("🌀 Syncing {} Workflow(s)...", workflows.len());

    cache_state
        .load_from_workflows(&workflows, &backend_name)
        .await?;

    let autostarts = AutostartTasks::prepare(backend, manager.inner(), &quick_runs, &workflows)?;
    crate::services::automation::runtime::refresh_with_definitions(
        &app_handle,
        Some(revision),
        Some(quick_runs),
        Some(workflows),
    )
    .await?;
    scheduler_state.initialize(app_handle.clone()).await?;
    scheduler_state
        .reload_automations(app_handle.clone())
        .await?;
    Ok(autostarts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::flow::workflow::types::{WorkflowNode, WorkflowNodeCategory};
    use crate::utils::{constants::SUB_QUICK_RUNS, types::remotes::OperationType};
    use serde_json::json;

    fn quick_run(id: &str, auto_start: bool) -> QuickRun {
        QuickRun {
            id: id.into(),
            name: id.into(),
            description: None,
            operation_type: OperationType::Copy,
            remote_name: "test".into(),
            config: json!({"app": {"autoStart": auto_start}, "rclone": {
                "srcFs": "/unused-source", "dstFs": "/unused-destination", "dryRun": true,
            }}),
        }
    }

    #[test]
    fn pending_autostarts_capture_only_selected_definitions_and_workflow_dependencies() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let manager = app.state::<AppSettingsManager>();
        let preset = quick_run("startup", true);
        manager
            .sub_settings(SUB_QUICK_RUNS)
            .unwrap()
            .set(&preset.id, &preset)
            .unwrap();
        let workflow = WorkflowDefinition {
            id: "workflow".into(),
            nodes: vec![
                WorkflowNode {
                    id: "start".into(),
                    node_type: "app_start".into(),
                    category: WorkflowNodeCategory::Trigger,
                    ..Default::default()
                },
                WorkflowNode {
                    id: "run".into(),
                    node_type: "quick_run".into(),
                    config: json!({"quickRunId": preset.id}),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let plan = AutostartTasks::prepare(
            Backend::new_local("Local"),
            manager.inner(),
            &[preset, quick_run("manual", false)],
            &[workflow, WorkflowDefinition::default()],
        )
        .unwrap();
        manager.lock().unwrap();
        assert_eq!(plan.tasks.len(), 2);
        assert!(matches!(&plan.tasks[0], AutostartTask::QuickRun(qr) if qr.id == "startup"));
        let AutostartTask::Workflow(snapshot) = &plan.tasks[1] else {
            panic!("Expected workflow inputs");
        };
        assert_eq!(snapshot.definition.id, "workflow");
        assert_eq!(snapshot.quick_runs["startup"].name, "startup");
        assert!(!snapshot.quick_runs.contains_key("manual"));
    }

    #[tokio::test]
    async fn failed_schedule_preparation_can_retry_and_preserves_installed_jobs() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        app.manage(AutomationScheduler::new());
        app.manage(crate::services::automation::watcher::WatcherManager::new());
        let manager = app.state::<AppSettingsManager>();
        let mut preset = quick_run("startup", true);
        preset.config["app"]["cronEnabled"] = json!(true);
        preset.config["app"]["cronExpression"] = json!("invalid");
        let store = manager.sub_settings(SUB_QUICK_RUNS).unwrap();
        store.set(&preset.id, &preset).unwrap();
        assert!(initialize_automations(app.clone()).await.is_err());

        preset.config["app"]["cronExpression"] = json!("0 0 1 1 *");
        store.set(&preset.id, &preset).unwrap();
        let first = initialize_automations(app.clone()).await.unwrap();
        app.state::<AutomationScheduler>().start().await.unwrap();
        let cache = app.state::<AutomationsCache>();
        let first_job = cache
            .get_automation(&preset.id)
            .await
            .unwrap()
            .scheduler_job_id
            .unwrap();
        let second = initialize_automations(app.clone()).await.unwrap();
        let second_job = cache
            .get_automation(&preset.id)
            .await
            .unwrap()
            .scheduler_job_id
            .unwrap();
        assert_eq!(first_job, second_job);
        assert_eq!(first.tasks.len(), 1);
        assert_eq!(second.tasks.len(), 1);
        app.state::<AutomationScheduler>().stop().await.unwrap();
    }
}
