//! Runs one workflow: schedules nodes as their inputs resolve and reports progress.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use futures::FutureExt;
use log::{info, warn};
use parking_lot::RwLock;
use serde_json::{Value, json};

use crate::context::AppHandle;
use crate::rclone::backend::types::Backend;
use crate::services::flow::workflow::dag::validate_workflow;
use crate::services::flow::workflow::engine::{
    RunContext,
    active::{ActiveWorkflowState, cleanup_workflow_resources, register_active_run},
    cancel::CancelToken,
    graph::{NodeFinishedEvent, RunGraph, RunState, emit_node_state},
    nodes::execute_single_node,
};
use crate::services::flow::workflow::types::{
    NodeExecutionOutput, NodeKind, WorkflowDefinition, WorkflowExecutionResult,
    WorkflowExecutionStateEvent, WorkflowNode, WorkflowNodeExecutionState, WorkflowProgress,
};
use crate::services::settings::AppSettingsManager;
use crate::utils::app::notification::{NotificationEvent, WorkflowStage, notify};
use crate::utils::types::{events::WORKFLOW_EXECUTION_STATE_CHANGED, origin::Origin};

/// A node that panics fails its own step; otherwise the run would wait forever
/// for a result that never arrives and keep its slot.
async fn catch_node_panic(
    node_id: &str,
    node: impl Future<Output = Result<NodeExecutionOutput, String>>,
) -> Result<NodeExecutionOutput, String> {
    match std::panic::AssertUnwindSafe(node).catch_unwind().await {
        Ok(outcome) => outcome,
        Err(payload) => {
            let reason = payload
                .downcast_ref::<&str>()
                .map(|reason| (*reason).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            log::error!("Workflow node '{node_id}' panicked: {reason}");
            Err(crate::localized_error!(
                "backendErrors.workflow.nodeCrashed",
                "node" => node_id,
                "reason" => reason
            ))
        }
    }
}

/// Executes a workflow by ID from storage using dynamic, dependency-driven DAG scheduling.
pub async fn execute_workflow(
    app: AppHandle,
    backend: Backend,
    workflow_id: String,
    dry_run: bool,
) -> Result<WorkflowExecutionResult, String> {
    execute_workflow_inner(app, backend, workflow_id, dry_run, None).await
}

pub(crate) async fn execute_workflow_snapshot(
    app: AppHandle,
    backend: Backend,
    snapshot: Arc<crate::services::automation::runtime::WorkflowSnapshot>,
    dry_run: bool,
) -> Result<WorkflowExecutionResult, String> {
    let id = snapshot.definition.id.clone();
    execute_workflow_inner(app, backend, id, dry_run, Some(snapshot)).await
}

async fn execute_workflow_inner(
    app: AppHandle,
    backend: Backend,
    workflow_id: String,
    dry_run: bool,
    prepared: Option<Arc<crate::services::automation::runtime::WorkflowSnapshot>>,
) -> Result<WorkflowExecutionResult, String> {
    // Coordinate starts made before Vault is enabled with its enable transition.
    // Vault-enabled runs use task snapshots prepared before autostart.
    let startup_state = if !app.state::<AppSettingsManager>().is_vault_enabled() {
        app.try_state::<crate::utils::types::state::RcloneState>()
    } else {
        None
    };
    let starting = match startup_state.as_ref() {
        Some(state) => Some(state.vault_operation_lock.lock().await),
        None => None,
    };
    let snapshot = match prepared {
        Some(snapshot) => snapshot,
        None => crate::services::automation::runtime::workflow(&app, &workflow_id)?,
    };
    let workflow = &snapshot.definition;

    info!(
        "Starting execution of workflow: {} ({workflow_id}, dry_run: {dry_run})",
        workflow.name
    );

    let val_res = validate_workflow(workflow);
    if !val_res.valid {
        // Each error is a translation key with its own parameters, so only the first is
        // passed on; the interface shows it, the log keeps them all.
        warn!(
            "Workflow '{workflow_id}' is invalid: {}",
            val_res.errors.join("; ")
        );
        let message = crate::localized_error!(
            "backendErrors.workflow.validationFailed",
            "error" => val_res.errors.first().map_or("", String::as_str)
        );
        crate::services::bridge::emit(
            WORKFLOW_EXECUTION_STATE_CHANGED,
            WorkflowExecutionStateEvent {
                workflow_id: workflow_id.clone(),
                state: "failed".to_string(),
                progress: None,
                message: Some(message.clone()),
            },
        );
        return Err(message);
    }

    let cancel = CancelToken::new();
    let active_job_ids = Arc::new(RwLock::new(HashSet::new()));
    let active_run = register_active_run(
        &workflow.name,
        &workflow_id,
        ActiveWorkflowState {
            backend: backend.clone(),
            cancel: cancel.clone(),
            active_job_ids: active_job_ids.clone(),
        },
    )?;

    drop(starting);

    let start_instant = Instant::now();
    let total_nodes = workflow.nodes.len();

    crate::services::bridge::emit(
        WORKFLOW_EXECUTION_STATE_CHANGED,
        WorkflowExecutionStateEvent {
            workflow_id: workflow_id.clone(),
            state: "started".to_string(),
            progress: Some(WorkflowProgress {
                total: total_nodes,
                completed: 0,
                current_step_title: crate::localized_success!(
                    "backendErrors.workflow.startingWorkflow"
                ),
            }),
            message: Some(crate::localized_success!(
                "backendErrors.workflow.started",
                "name" => workflow.name
            )),
        },
    );

    notify(
        &app,
        NotificationEvent::Workflow(WorkflowStage::Started {
            workflow_id: workflow_id.clone(),
            workflow_name: workflow.name.clone(),
            origin: Origin::Flow,
        }),
    );

    let graph = RunGraph::new(workflow);
    let mut state = RunState::new(&graph, workflow);

    let ctx = Arc::new(RunContext {
        app: app.clone(),
        backend: backend.clone(),
        snapshot: snapshot.clone(),
        cancel: cancel.clone(),
        active_jobs: active_job_ids,
        node_results: Arc::new(RwLock::new(HashMap::new())),
        run_id: uuid::Uuid::new_v4().to_string(),
        dry_run,
    });
    let (tx, mut rx) = tokio::sync::mpsc::channel::<NodeFinishedEvent>(total_nodes.max(1));

    let mut running: Vec<usize> = Vec::new();
    // A stop node ends scheduling; nodes already running are left to finish.
    let mut halted = false;

    loop {
        // 1. Spawn all currently ready nodes (unless stopped or cancelled)
        if halted || cancel.is_cancelled() {
            state.stop_scheduling();
        } else {
            while let Some(idx) = state.start_next() {
                running.push(idx);
                emit_node_state(
                    &workflow_id,
                    &workflow.nodes[idx].id,
                    WorkflowNodeExecutionState::Running,
                    None,
                    None,
                    None,
                );

                let ctx = ctx.clone();
                let tx = tx.clone();
                crate::utils::spawn(async move {
                    let node_start = Instant::now();
                    let node = &ctx.snapshot.definition.nodes[idx];
                    let outcome = catch_node_panic(&node.id, execute_single_node(&ctx, node)).await;
                    let duration_ms = node_start.elapsed().as_millis() as u64;
                    let _ = tx
                        .send(NodeFinishedEvent {
                            node_idx: idx,
                            outcome,
                            duration_ms,
                        })
                        .await;
                });
            }
        }

        // If no tasks are running and nothing is queued, we are done
        if running.is_empty() {
            break;
        }

        // Emit current running progress
        let running_titles = running
            .iter()
            .map(|&idx| workflow.nodes[idx].title.as_str())
            .collect::<Vec<_>>()
            .join(", ");

        crate::services::bridge::emit(
            WORKFLOW_EXECUTION_STATE_CHANGED,
            WorkflowExecutionStateEvent {
                workflow_id: workflow_id.clone(),
                state: "running".to_string(),
                progress: Some(WorkflowProgress {
                    total: total_nodes,
                    completed: state.completed,
                    current_step_title: if running_titles.is_empty() {
                        crate::localized_success!("backendErrors.workflow.processing")
                    } else {
                        running_titles
                    },
                }),
                message: None,
            },
        );

        // Await next node completion
        let Some(finished) = rx.recv().await else {
            break;
        };
        let idx = finished.node_idx;
        running.retain(|&running_idx| running_idx != idx);
        let node = &workflow.nodes[idx];
        state.activate_edges(&graph, workflow, idx, &finished.outcome);
        halted |= record_node_outcome(&ctx, &workflow_id, node, idx, &mut state, finished);

        // 2. Unless stopped or cancelled, queue the nodes this one opened up
        if !halted && !cancel.is_cancelled() {
            state.queue_downstream(&graph, workflow, &workflow_id, idx);
        }
    }

    state.skip_unreached(workflow, &workflow_id);
    drop(active_run);

    let outcome = RunOutcome {
        halted,
        dry_run,
        cancelled: cancel.is_cancelled(),
        elapsed: start_instant.elapsed(),
    };
    Ok(finish_run(&app, &backend, workflow, workflow_id, &state, outcome).await)
}

/// Whether the node asks to stop the run. Other nodes report `stopped` for what
/// they stopped (a serve), not for the run.
fn ends_run(kind: NodeKind, output: &Value) -> bool {
    kind == NodeKind::Stop && output.get("stopped").and_then(Value::as_bool) == Some(true)
}

/// Stores what a finished node produced, tells the interface, and reports whether it asked to stop the run.
fn record_node_outcome(
    ctx: &RunContext,
    workflow_id: &str,
    node: &WorkflowNode,
    idx: usize,
    state: &mut RunState,
    finished: NodeFinishedEvent,
) -> bool {
    let mut halts_run = false;
    match finished.outcome {
        Ok(output) => {
            let is_failure_branch = output.branch.as_deref() == Some("failure");
            let is_node_success = output
                .value
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(!is_failure_branch);
            let error_message = output
                .value
                .get("error")
                .or_else(|| output.value.get("errorMessage"))
                .and_then(Value::as_str);

            if is_node_success {
                state.succeeded(idx);
            } else {
                state.failed(idx, true);
            }

            if ends_run(node.kind(), &output.value) {
                info!(
                    "Workflow received graceful stop from node '{}'. Halting remaining DAG execution.",
                    node.id
                );
                halts_run = true;
            }

            emit_node_state(
                workflow_id,
                &node.id,
                if is_node_success {
                    WorkflowNodeExecutionState::Success
                } else {
                    WorkflowNodeExecutionState::Failed
                },
                error_message,
                Some(finished.duration_ms),
                Some(&output.value),
            );
            ctx.node_results
                .write()
                .insert(node.id.clone(), output.value);
        }
        Err(err) => {
            state.failed(idx, !ctx.cancel.is_cancelled());

            // Outputs feed `{{nodes.<id>.error}}` into notifications, so they carry
            // text in the current language; the event carries the key for the interface.
            let text = crate::utils::i18n::render_message(&err);
            let err_payload = json!({
                "success": false,
                "status": "failed",
                "error": text,
                "errorMessage": text,
                "summary": crate::t!("backendErrors.workflow.stepFailed", "error" => text),
            });
            emit_node_state(
                workflow_id,
                &node.id,
                WorkflowNodeExecutionState::Failed,
                Some(&err),
                Some(finished.duration_ms),
                Some(&err_payload),
            );
            ctx.node_results
                .write()
                .insert(node.id.clone(), err_payload);
        }
    }
    halts_run
}

/// How a run ended, for the record and the final report.
struct RunOutcome {
    /// A stop node ended scheduling.
    halted: bool,
    dry_run: bool,
    cancelled: bool,
    elapsed: Duration,
}

/// Records the run, reports how it ended and builds its result.
async fn finish_run(
    app: &AppHandle,
    backend: &Backend,
    workflow: &WorkflowDefinition,
    workflow_id: String,
    state: &RunState,
    outcome: RunOutcome,
) -> WorkflowExecutionResult {
    let RunOutcome {
        halted,
        dry_run,
        cancelled: is_cancelled,
        elapsed,
    } = outcome;
    let total_nodes = workflow.nodes.len();
    let (completed_nodes, failed_nodes, skipped_nodes) =
        (state.completed, state.failed, state.skipped);
    let total_duration_ms = elapsed.as_millis() as u64;
    let overall_success = !is_cancelled && failed_nodes == 0;

    // Only the timestamp is written: the stored definition may have been edited
    // or deleted while this run was executing.
    let completed_at = Utc::now().to_rfc3339();
    let manager = app.state::<AppSettingsManager>();
    if !manager.is_vault_enabled() {
        if let Err(error) = crate::services::flow::workflow::commands::record_last_executed(
            &manager,
            &workflow_id,
            &completed_at,
        ) {
            warn!("Failed to save workflow completion: {error}");
        }
    } else if let Some(runtime) =
        app.try_state::<crate::services::automation::runtime::RuntimeTasks>()
    {
        runtime.record_completion(&workflow_id, completed_at);
        if !manager.is_locked()
            && let Err(error) = crate::services::automation::runtime::flush_completions(app).await
        {
            warn!("Failed to save workflow completion: {error}");
        }
    }

    let final_state = if is_cancelled {
        "cancelled"
    } else if overall_success {
        "completed"
    } else {
        "failed"
    };

    crate::services::bridge::emit(
        WORKFLOW_EXECUTION_STATE_CHANGED,
        WorkflowExecutionStateEvent {
            workflow_id: workflow_id.clone(),
            state: final_state.to_string(),
            progress: Some(WorkflowProgress {
                total: total_nodes,
                completed: completed_nodes,
                current_step_title: crate::localized_success!("backendErrors.workflow.finished"),
            }),
            message: Some(if is_cancelled {
                crate::localized_success!("backendErrors.workflow.stoppedByUser")
            } else if overall_success && halted {
                crate::localized_success!(
                    "backendErrors.workflow.completedViaStop",
                    "name" => workflow.name
                )
            } else if overall_success && dry_run {
                crate::localized_success!(
                    "backendErrors.workflow.completedSimulation",
                    "name" => workflow.name
                )
            } else if overall_success {
                crate::localized_success!(
                    "backendErrors.workflow.completedSuccessfully",
                    "name" => workflow.name
                )
            } else {
                crate::localized_success!(
                    "backendErrors.workflow.finishedWithFailures",
                    "name" => workflow.name,
                    "count" => failed_nodes
                )
            }),
        },
    );

    if failed_nodes > 0 {
        // Clean up any orphan mounts or serves left behind by the failed workflow execution
        cleanup_workflow_resources(app, backend, &workflow_id).await;

        notify(
            app,
            NotificationEvent::Workflow(WorkflowStage::Failed {
                workflow_id: workflow_id.clone(),
                workflow_name: workflow.name.clone(),
                error: crate::localized_error!(
                    "backendErrors.workflow.stepsFailed",
                    "count" => failed_nodes
                ),
                failed_node_title: None,
                origin: Origin::Flow,
            }),
        );
    } else if is_cancelled {
        notify(
            app,
            NotificationEvent::Workflow(WorkflowStage::Stopped {
                workflow_id: workflow_id.clone(),
                workflow_name: workflow.name.clone(),
                origin: Origin::Flow,
            }),
        );
    } else {
        notify(
            app,
            NotificationEvent::Workflow(WorkflowStage::Completed {
                workflow_id: workflow_id.clone(),
                workflow_name: workflow.name.clone(),
                duration_ms: total_duration_ms,
                origin: Origin::Flow,
            }),
        );
    }

    WorkflowExecutionResult {
        workflow_id,
        success: overall_success,
        total_nodes,
        completed_nodes,
        failed_nodes,
        skipped_nodes,
        duration_ms: total_duration_ms,
        dry_run,
        error: if failed_nodes > 0 {
            Some(crate::localized_error!(
                "backendErrors.workflow.stepsFailed",
                "count" => failed_nodes
            ))
        } else if is_cancelled {
            Some(crate::localized_error!(
                "backendErrors.workflow.executionCancelled"
            ))
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};

    use super::*;

    use crate::rclone::backend::types::Backend;

    use crate::services::flow::workflow::engine::active::{is_workflow_active, stop_workflow};
    use crate::services::flow::workflow::types::*;
    use crate::services::settings::AppSettingsManager;
    use crate::utils::constants::SUB_WORKFLOWS;

    fn timed_workflow(id: &str, delay_seconds: u64) -> WorkflowDefinition {
        WorkflowDefinition {
            id: id.into(),
            name: id.into(),
            nodes: vec![WorkflowNode {
                id: "start".into(),
                node_type: "app_start".into(),
                category: WorkflowNodeCategory::Trigger,
                config: json!({"delaySeconds": delay_seconds}),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_running_timer_continues_with_its_snapshot_after_the_real_vault_locks() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let workflow = WorkflowDefinition {
            id: "active-timer-vault-test".into(),
            name: "Timer".into(),
            nodes: vec![WorkflowNode {
                id: "wait".into(),
                node_type: "delay".into(),
                config: json!({"delaySeconds": 1}),
                ..Default::default()
            }],
            ..Default::default()
        };
        app.state::<AppSettingsManager>()
            .sub_settings(crate::utils::constants::SUB_WORKFLOWS)
            .unwrap()
            .set(&workflow.id, &workflow)
            .unwrap();
        crate::services::automation::runtime::refresh(&app)
            .await
            .unwrap();
        assert!(
            app.state::<crate::services::automation::runtime::RuntimeTasks>()
                .workflow(&workflow.id)
                .is_none()
        );
        let execution_app = app.clone();
        let id = workflow.id.clone();
        let execution = crate::utils::spawn(async move {
            execute_workflow(execution_app, Backend::new_local("Local"), id, false).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !is_workflow_active("Local", &workflow.id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        app.state::<AppSettingsManager>().lock().unwrap();
        let result = execution.await.unwrap().unwrap();
        assert!(result.success);
        assert_eq!(result.completed_nodes, 1);
        assert!(app.state::<AppSettingsManager>().get_all().is_err());
    }

    #[tokio::test]
    async fn a_prepared_startup_workflow_can_begin_after_the_vault_locks() {
        use crate::services::automation::runtime::WorkflowSnapshot;

        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let workflow = WorkflowDefinition {
            id: "prepared-startup-vault-test".into(),
            name: "Prepared startup".into(),
            nodes: vec![WorkflowNode {
                id: "start".into(),
                node_type: "app_start".into(),
                category: WorkflowNodeCategory::Trigger,
                config: json!({"delaySeconds": 0}),
                ..Default::default()
            }],
            ..Default::default()
        };
        let manager = app.state::<AppSettingsManager>();
        let snapshot = Arc::new(WorkflowSnapshot::capture(manager.inner(), workflow).unwrap());
        manager.lock().unwrap();
        let result = execute_workflow_snapshot(app, Backend::new_local("Local"), snapshot, false)
            .await
            .unwrap();
        assert!(result.success);
        assert_eq!(result.completed_nodes, 1);
        assert!(manager.is_locked());
    }

    #[tokio::test]
    async fn an_overlapping_start_is_refused_without_disturbing_the_running_workflow() {
        use crate::services::automation::runtime::WorkflowSnapshot;
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let manager = app.state::<AppSettingsManager>();
        let snapshot = Arc::new(
            WorkflowSnapshot::capture(manager.inner(), timed_workflow("overlap-test", 1)).unwrap(),
        );
        let first = execute_workflow_snapshot(
            app.clone(),
            Backend::new_local("Local"),
            snapshot.clone(),
            false,
        );
        let second = async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let refused = execute_workflow_snapshot(
                app.clone(),
                Backend::new_local("Local"),
                snapshot.clone(),
                false,
            )
            .await;
            // The refused start must leave the first run registered and stoppable.
            let still_registered = is_workflow_active("Local", "overlap-test");
            (refused, still_registered)
        };

        let (first, (refused, still_registered)) = tokio::join!(first, second);
        assert!(first.unwrap().success);
        assert!(
            refused
                .unwrap_err()
                .contains("backendErrors.automation.workflowAlreadyRunning")
        );
        assert!(still_registered);
        assert!(!is_workflow_active("Local", "overlap-test"));
    }

    #[test]
    fn the_same_workflow_id_may_run_on_two_backends_but_not_twice_on_one() {
        use crate::services::flow::workflow::engine::active::{
            ActiveWorkflowState, register_active_run,
        };
        let state = |backend: &str| ActiveWorkflowState {
            backend: Backend::new_remote(backend, "127.0.0.1", 0),
            cancel: crate::services::flow::workflow::engine::cancel::CancelToken::new(),
            active_job_ids: Arc::new(RwLock::new(HashSet::new())),
        };
        let on_nas = register_active_run("Backup", "copied-id", state("NAS-run")).unwrap();
        // Copying workflows to another backend keeps their ids; that copy is a different workflow.
        let on_other = register_active_run("Backup", "copied-id", state("Other-run")).unwrap();
        assert!(register_active_run("Backup", "copied-id", state("NAS-run")).is_err());
        assert!(is_workflow_active("NAS-run", "copied-id"));
        assert!(is_workflow_active("Other-run", "copied-id"));
        assert!(!is_workflow_active("Third-run", "copied-id"));

        drop(on_nas);
        assert!(!is_workflow_active("NAS-run", "copied-id"));
        assert!(is_workflow_active("Other-run", "copied-id"));
        drop(on_other);
    }

    #[tokio::test]
    async fn a_finished_workflow_can_run_again() {
        use crate::services::automation::runtime::WorkflowSnapshot;
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let manager = app.state::<AppSettingsManager>();
        let snapshot = Arc::new(
            WorkflowSnapshot::capture(manager.inner(), timed_workflow("rerun-test", 0)).unwrap(),
        );
        for _ in 0..2 {
            let result = execute_workflow_snapshot(
                app.clone(),
                Backend::new_local("Local"),
                snapshot.clone(),
                false,
            )
            .await
            .unwrap();
            assert!(result.success);
            assert!(!is_workflow_active("Local", "rerun-test"));
        }
    }

    #[tokio::test]
    async fn a_panicking_node_fails_its_step_instead_of_hanging_the_run() {
        let failing = async {
            let missing: Option<u8> = None;
            missing.expect("boom");
            Ok(NodeExecutionOutput::new(json!({})))
        };
        let error = catch_node_panic("node-1", failing).await.unwrap_err();
        assert!(
            error.contains("node-1") && error.contains("boom"),
            "{error}"
        );

        let fine = catch_node_panic("node-2", async {
            Ok(NodeExecutionOutput::new(json!({"ok": true})))
        })
        .await
        .unwrap();
        assert_eq!(fine.value["ok"], true);
    }

    #[tokio::test]
    async fn an_unsupported_node_type_fails_its_step() {
        use crate::services::automation::runtime::WorkflowSnapshot;
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let workflow = WorkflowDefinition {
            id: "unsupported-node-test".into(),
            name: "Unsupported".into(),
            nodes: vec![
                WorkflowNode {
                    id: "start".into(),
                    node_type: "manual".into(),
                    category: WorkflowNodeCategory::Trigger,
                    ..Default::default()
                },
                WorkflowNode {
                    id: "mystery".into(),
                    node_type: "does_not_exist".into(),
                    ..Default::default()
                },
            ],
            edges: vec![WorkflowEdge {
                id: "e1".into(),
                source_node_id: "start".into(),
                source_port_id: "out".into(),
                target_node_id: "mystery".into(),
                target_port_id: "in".into(),
                is_active: None,
            }],
            ..Default::default()
        };
        let manager = app.state::<AppSettingsManager>();
        let snapshot = Arc::new(WorkflowSnapshot::capture(manager.inner(), workflow).unwrap());
        let result = execute_workflow_snapshot(app, Backend::new_local("Local"), snapshot, false)
            .await
            .unwrap();
        assert!(!result.success);
        assert_eq!(result.failed_nodes, 1);
    }

    #[tokio::test]
    async fn finishing_a_run_keeps_edits_made_while_it_was_running() {
        use crate::context::AppHandle;
        use crate::services::flow::workflow::commands::{get_workflow_by_id, save_workflow_record};
        let directory = tempfile::tempdir().unwrap();
        let manager: AppSettingsManager = rcman::SettingsManager::builder("run-edit-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_WORKFLOWS))
            .build()
            .unwrap();
        for id in ["edited-while-running", "deleted-while-running"] {
            save_workflow_record(&manager, &timed_workflow(id, 1)).unwrap();
        }
        let app = AppHandle::default();
        app.manage(manager);
        let manager = app.state::<AppSettingsManager>();

        let runs = async {
            tokio::join!(
                execute_workflow(
                    app.clone(),
                    Backend::new_local("Local"),
                    "edited-while-running".into(),
                    false
                ),
                execute_workflow(
                    app.clone(),
                    Backend::new_local("Local"),
                    "deleted-while-running".into(),
                    false
                ),
            )
        };
        let user = async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let mut edited = timed_workflow("edited-while-running", 1);
            edited.name = "Renamed by the user".into();
            save_workflow_record(&manager, &edited).unwrap();
            crate::services::flow::workflow::commands::delete_workflow_by_id_sync(
                &manager,
                "deleted-while-running",
            )
            .unwrap();
        };
        let ((first, second), ()) = tokio::join!(runs, user);
        assert!(first.unwrap().success);
        assert!(second.unwrap().success);

        let edited = get_workflow_by_id(&manager, "edited-while-running")
            .unwrap()
            .unwrap();
        assert_eq!(edited.name, "Renamed by the user");
        assert!(edited.last_executed_at.is_some());
        assert!(
            get_workflow_by_id(&manager, "deleted-while-running")
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_stop_node_lets_running_nodes_finish_but_starts_nothing_new() {
        use crate::services::automation::runtime::WorkflowSnapshot;
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let node = |id: &str, node_type: &str, config: Value| WorkflowNode {
            id: id.into(),
            node_type: node_type.into(),
            config,
            ..Default::default()
        };
        let workflow = WorkflowDefinition {
            id: "halt-test".into(),
            name: "Halt".into(),
            nodes: vec![
                WorkflowNode {
                    category: WorkflowNodeCategory::Trigger,
                    ..node("slow", "app_start", json!({"delaySeconds": 1}))
                },
                WorkflowNode {
                    category: WorkflowNodeCategory::Trigger,
                    ..node("stop", "stop", json!({}))
                },
                node("after", "log_audit", json!({})),
            ],
            edges: vec![WorkflowEdge {
                id: "e1".into(),
                source_node_id: "slow".into(),
                source_port_id: "out".into(),
                target_node_id: "after".into(),
                target_port_id: "in".into(),
                is_active: None,
            }],
            ..Default::default()
        };
        let manager = app.state::<AppSettingsManager>();
        let snapshot = Arc::new(WorkflowSnapshot::capture(manager.inner(), workflow).unwrap());
        let result = execute_workflow_snapshot(app, Backend::new_local("Local"), snapshot, false)
            .await
            .unwrap();

        // The slow node was not cancelled by the stop node, and nothing started afterwards.
        assert!(result.success, "{result:?}");
        assert_eq!(result.completed_nodes, 2);
        assert_eq!(result.failed_nodes, 0);
        assert_eq!(result.skipped_nodes, 1);
    }

    #[tokio::test]
    async fn stopping_a_workflow_interrupts_a_long_wait_promptly() {
        use crate::services::automation::runtime::WorkflowSnapshot;
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let manager = app.state::<AppSettingsManager>();
        let snapshot = Arc::new(
            WorkflowSnapshot::capture(manager.inner(), timed_workflow("stop-wait-test", 3600))
                .unwrap(),
        );
        let started = Instant::now();
        let run =
            execute_workflow_snapshot(app.clone(), Backend::new_local("Local"), snapshot, false);
        let stopper = async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            stop_workflow(&app, "stop-wait-test").await.unwrap();
        };

        let (result, ()) = tokio::join!(run, stopper);
        let result = result.unwrap();
        assert!(!result.success);
        assert!(
            result
                .error
                .unwrap()
                .contains("backendErrors.workflow.executionCancelled")
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn only_a_stop_node_ends_the_run() {
        let stopped = serde_json::json!({"stopped": true});
        assert!(ends_run(NodeKind::Stop, &stopped));
        assert!(!ends_run(NodeKind::StopServe, &stopped));
        assert!(!ends_run(
            NodeKind::Stop,
            &serde_json::json!({"stopped": false})
        ));
        assert!(!ends_run(NodeKind::Stop, &serde_json::json!({})));
    }
}
