//! Node execution: each kind of node has one handler, reached from [`execute_single_node`].

use serde_json::{Value, json};

use crate::services::flow::workflow::engine::RunContext;
use crate::services::flow::workflow::interpolation::interpolate_node_config_with_context;
use crate::services::flow::workflow::types::{NodeExecutionOutput, NodeKind, WorkflowNode};
use crate::utils::types::remotes::OperationType;

pub(crate) mod actions;
pub(crate) mod flow;
pub(crate) mod jobs;
pub(crate) mod mounts;
pub(crate) mod notification;
pub(crate) mod rc;

/// The remote and the operation options of a node, in either of the shapes the editor saves.
pub(crate) struct NodeOpConfig<'a> {
    remote: &'a str,
    config: &'a Value,
    empty_settings: Value,
}

pub(crate) fn extract_node_op_config<'a>(config: &'a Value) -> NodeOpConfig<'a> {
    let remote = config
        .get("remoteName")
        .or_else(|| config.get("remote"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    let op_config = config.get("config").unwrap_or(config);

    NodeOpConfig {
        remote,
        config: op_config,
        empty_settings: json!({"name": remote.trim_end_matches(':')}),
    }
}

/// Dispatches an individual node's execution based on its kind and interpolated config.
pub(crate) async fn execute_single_node(
    ctx: &RunContext,
    node: &WorkflowNode,
) -> Result<NodeExecutionOutput, String> {
    if ctx.cancel.is_cancelled() {
        return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
    }

    let workflow = &ctx.snapshot.definition;
    let interpolated_config = {
        let results = ctx.node_results.read();
        interpolate_node_config_with_context(&node.config, &results, Some(workflow), Some(&node.id))
    };
    let config = &interpolated_config;
    let (cancel, dry_run) = (&ctx.cancel, ctx.dry_run);

    match node.kind() {
        kind @ (NodeKind::Manual
        | NodeKind::ParallelFork
        | NodeKind::Cron
        | NodeKind::Watcher
        | NodeKind::JobEvent) => Ok(flow::trigger_output(kind, config)),
        NodeKind::Join => {
            let results = ctx.node_results.read();
            flow::handle_join_node(node, workflow, config, &results)
        }
        NodeKind::AppStart => flow::handle_app_start_node(config, cancel, dry_run).await,
        NodeKind::Delay => flow::execute_delay_node(config, cancel).await,
        NodeKind::ScheduleWait => flow::execute_schedule_wait_node(config, cancel, dry_run).await,
        NodeKind::Condition => flow::condition_node(config).await,
        NodeKind::Stop => flow::handle_stop_node(config),
        NodeKind::Notification => {
            notification::execute_notification_node(&ctx.app, node, workflow, config).await
        }
        NodeKind::ExecScript => actions::handle_exec_script_node(config, cancel, dry_run).await,
        NodeKind::LogAudit => Ok(actions::log_audit_node(workflow, config)),
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        NodeKind::SystemPower => actions::system_power_node(config, dry_run).await,
        NodeKind::RcCommand => rc::rc_command_node(ctx, config).await,
        NodeKind::Cleanup => rc::cleanup_node(ctx, config).await,
        NodeKind::QuickRun => jobs::quick_run_node(ctx, node, config).await,
        NodeKind::Unmount => mounts::unmount_node(ctx, config).await,
        NodeKind::StopServe => mounts::stop_serve_node(ctx, config).await,
        NodeKind::Operation(OperationType::Mount) => mounts::mount_node(ctx, node, config).await,
        NodeKind::Operation(OperationType::Serve) => mounts::serve_node(ctx, node, config).await,
        NodeKind::Operation(operation) => jobs::transfer_node(ctx, node, config, operation).await,
        #[cfg(any(target_os = "android", target_os = "ios"))]
        NodeKind::SystemPower => Err(unsupported_node_type(node)),
        NodeKind::Unknown => Err(unsupported_node_type(node)),
    }
}

fn unsupported_node_type(node: &WorkflowNode) -> String {
    crate::localized_error!(
        "backendErrors.workflow.unsupportedNodeType",
        "type" => node.node_type
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;

    use parking_lot::RwLock;

    use crate::rclone::backend::types::Backend;
    use crate::services::flow::workflow::engine::cancel::CancelToken;
    use std::collections::HashMap;

    use serde_json::{Value, json};

    use super::*;
    use crate::context::AppHandle;

    use crate::services::flow::workflow::types::*;
    use crate::services::settings::AppSettingsManager;

    fn test_context(
        app: &AppHandle,
        snapshot: crate::services::automation::runtime::WorkflowSnapshot,
        node_results: HashMap<String, Value>,
    ) -> RunContext {
        RunContext {
            app: app.clone(),
            backend: Backend::new_local("Local"),
            snapshot: Arc::new(snapshot),
            cancel: CancelToken::new(),
            active_jobs: Arc::new(RwLock::new(HashSet::new())),
            node_results: Arc::new(RwLock::new(node_results)),
            run_id: "test-run".into(),
            dry_run: true,
        }
    }

    #[tokio::test]
    async fn a_workflow_retains_only_its_quick_run_dependency_for_later_nodes() {
        use crate::services::{
            automation::runtime::WorkflowSnapshot, flow::quick_run::types::QuickRun,
        };
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let qr: QuickRun = serde_json::from_value(json!({"id": "needed", "name": "Needed preset", "operationType": "copy", "remoteName": "drive", "config": {"source": "/src", "dest": "/dst"}})).unwrap();
        let sub = app
            .state::<AppSettingsManager>()
            .sub_settings(crate::utils::constants::SUB_QUICK_RUNS)
            .unwrap();
        sub.set(&qr.id, &qr).unwrap();
        // An unrelated malformed preset must not prevent this execution.
        sub.set("unrelated", &json!({"invalid": true})).unwrap();
        let node = WorkflowNode {
            id: "later-node".into(),
            node_type: "quick_run".into(),
            config: json!({"quickRunId": "needed"}),
            ..Default::default()
        };
        let workflow = WorkflowDefinition {
            id: "active-quick-run-vault-test".into(),
            nodes: vec![
                WorkflowNode {
                    node_type: "job_event".into(),
                    config: json!({"targetProfileId": "Needed preset"}),
                    ..Default::default()
                },
                node.clone(),
            ],
            ..Default::default()
        };
        let snapshot =
            WorkflowSnapshot::capture(app.state::<AppSettingsManager>().inner(), workflow).unwrap();
        assert_eq!(snapshot.quick_runs.len(), 1);
        assert!(!snapshot.quick_runs.contains_key("unrelated"));
        assert!(snapshot.quick_run_names.is_empty());
        app.state::<AppSettingsManager>().lock().unwrap();
        let output = execute_single_node(&test_context(&app, snapshot, HashMap::new()), &node)
            .await
            .unwrap();
        assert_eq!(output.value["name"], "Needed preset");
        assert!(app.state::<AppSettingsManager>().get_all().is_err());
    }

    #[tokio::test]
    async fn dynamic_quick_run_references_work_while_unlocked_without_caching_all_presets() {
        use crate::services::{
            automation::runtime::WorkflowSnapshot, flow::quick_run::types::QuickRun,
        };
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        let preset: QuickRun = serde_json::from_value(json!({"id": "dynamic-target", "name": "Dynamic preset", "operationType": "copy", "remoteName": "drive", "config": {}})).unwrap();
        app.state::<AppSettingsManager>()
            .sub_settings(crate::utils::constants::SUB_QUICK_RUNS)
            .unwrap()
            .set(&preset.id, &preset)
            .unwrap();
        let node = WorkflowNode {
            id: "run".into(),
            node_type: "quick_run".into(),
            config: json!({"quickRunId": "{{nodes.source.preset}}"}),
            ..Default::default()
        };
        let workflow = WorkflowDefinition {
            nodes: vec![node.clone()],
            ..Default::default()
        };
        let snapshot =
            WorkflowSnapshot::capture(app.state::<AppSettingsManager>().inner(), workflow).unwrap();
        assert!(snapshot.quick_runs.is_empty());
        let ctx = test_context(
            &app,
            snapshot,
            HashMap::from([("source".into(), json!({"preset": preset.id}))]),
        );
        for locked in [false, true] {
            if locked {
                app.state::<AppSettingsManager>().lock().unwrap();
            }
            let result = execute_single_node(&ctx, &node).await;
            if locked {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap().value["name"], "Dynamic preset");
            }
        }
    }

    #[test]
    fn test_workflow_operation_node_config_parsing() {
        use crate::rclone::commands::common::parse_common_config;
        use crate::rclone::commands::mount::MountParams;

        let structured_mount = json!({
            "remoteName": "drive",
            "config": {
                "app": { "autoStart": false, "showOnTray": true },
                "rclone": {
                    "fs": "drive:",
                    "mountPoint": "/home/user/drive",
                    "vfs_cache_mode": "full"
                }
            }
        });

        let op = extract_node_op_config(&structured_mount);
        let mount_params =
            MountParams::from_config(op.remote.to_string(), op.config, &op.empty_settings)
                .expect("Failed to parse mount params");

        assert_eq!(mount_params.remote_name, "drive");
        assert_eq!(mount_params.mount_point, "/home/user/drive");
        assert_eq!(mount_params.source, "drive:");

        let body = mount_params.to_rclone_body().unwrap();
        assert_eq!(body.get("fs").and_then(Value::as_str), Some("drive:"));
        assert_eq!(
            body.get("mountPoint").and_then(Value::as_str),
            Some("/home/user/drive")
        );
        assert!(body.get("remote").is_none());
        assert!(body.get("remoteName").is_none());

        let structured_sync = json!({
            "remoteName": "drive",
            "config": {
                "app": { "autoStart": false },
                "rclone": {
                    "srcFs": "drive:",
                    "dstFs": "/home/user/backup",
                    "transfers": 4
                }
            }
        });

        let sync_op = extract_node_op_config(&structured_sync);
        let common = parse_common_config(sync_op.config, &sync_op.empty_settings)
            .expect("Failed to parse transfer config");

        assert_eq!(sync_op.remote, "drive");
        assert_eq!(common.source, vec!["drive:".to_string()]);
        assert_eq!(common.dest, "/home/user/backup".to_string());

        let structured_cryptcheck = json!({
            "remoteName": "secret-crypt",
            "config": {
                "rclone": {
                    "srcFs": "/local/data",
                    "dstFs": "encrypted_folder"
                }
            }
        });

        let crypt_op = extract_node_op_config(&structured_cryptcheck);
        let crypt_common = parse_common_config(crypt_op.config, &crypt_op.empty_settings)
            .expect("Failed to parse cryptcheck transfer config");

        assert_eq!(crypt_op.remote, "secret-crypt");
        assert_eq!(crypt_common.source, vec!["/local/data".to_string()]);
        assert_eq!(crypt_common.dest, "encrypted_folder".to_string());

        let dest_resolved = if !crypt_op.remote.is_empty()
            && !crypt_common.dest.is_empty()
            && !crypt_common.dest.contains(':')
        {
            format!("{}:{}", crypt_op.remote, crypt_common.dest)
        } else {
            crypt_common.dest.clone()
        };
        assert_eq!(dest_resolved, "secret-crypt:encrypted_folder");

        let structured_copyurl = json!({
            "remoteName": "backup-drive",
            "config": {
                "rclone": {
                    "url": "https://example.com/archive.zip",
                    "dstFs": "incoming",
                    "autoFilename": true
                }
            }
        });

        let copyurl_op = extract_node_op_config(&structured_copyurl);
        let copyurl_common = parse_common_config(copyurl_op.config, &copyurl_op.empty_settings)
            .expect("Failed to parse copyurl transfer config");

        assert_eq!(copyurl_op.remote, "backup-drive");
        assert_eq!(
            copyurl_common.source,
            vec!["https://example.com/archive.zip".to_string()]
        );
        assert_eq!(copyurl_common.dest, "incoming".to_string());

        let copyurl_dest_resolved =
            if !copyurl_op.remote.is_empty() && !copyurl_common.dest.contains(':') {
                if copyurl_common.dest.is_empty() {
                    format!("{}:", copyurl_op.remote)
                } else {
                    format!("{}:{}", copyurl_op.remote, copyurl_common.dest)
                }
            } else {
                copyurl_common.dest.clone()
            };
        assert_eq!(copyurl_dest_resolved, "backup-drive:incoming");

        let copyurl_body = crate::rclone::commands::sync::GenericTransferParams {
            source: copyurl_common.source[0].clone(),
            dest: copyurl_dest_resolved,
            rclone_config: copyurl_common.rclone_config.clone(),
            filter_options: copyurl_common.filter_options.clone(),
            backend_options: None,
            runtime_remote_options: copyurl_common.runtime_remote_options.clone(),
            transfer_type: OperationType::Copyurl,
            is_dir: false,
            dry_run: None,
        }
        .to_rclone_body(false)
        .expect("Failed to generate copyurl rclone body");

        assert_eq!(
            copyurl_body.get("url").unwrap(),
            "https://example.com/archive.zip"
        );
        assert_eq!(copyurl_body.get("fs").unwrap(), "backup-drive:");
        assert_eq!(copyurl_body.get("remote").unwrap(), "incoming");
        assert_eq!(copyurl_body.get("autoFilename").unwrap(), true);
        assert_eq!(
            copyurl_body.get("_path").unwrap(),
            crate::rclone::endpoints::operations::COPYURL
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[tokio::test]
    async fn test_system_power_dry_run_simulation() {
        let node = WorkflowNode {
            node_type: "system_power".into(),
            config: json!({ "action": "sleep" }),
            ..Default::default()
        };
        let snapshot = crate::services::automation::runtime::WorkflowSnapshot {
            definition: WorkflowDefinition::default(),
            quick_runs: HashMap::new(),
            quick_run_names: HashMap::new(),
        };
        let output = execute_single_node(
            &test_context(&AppHandle::default(), snapshot, HashMap::new()),
            &node,
        )
        .await
        .expect("Dry run system power node should succeed");
        assert_eq!(
            output.value.get("powerAction").and_then(Value::as_str),
            Some("sleep")
        );
        assert_eq!(
            output.value.get("executed").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            output.value.get("dryRun").and_then(Value::as_bool),
            Some(true)
        );
    }
}
