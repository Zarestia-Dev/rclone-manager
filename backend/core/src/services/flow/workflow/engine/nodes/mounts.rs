//! Mount, unmount, serve and stop-serve nodes.

use std::collections::HashMap;

use log::{info, warn};
use serde_json::{Value, json};

use crate::rclone::backend::BackendManager;
use crate::rclone::commands::{
    mount::{MountParams, mount_remote},
    serve::{ServeParams, start_serve},
};
use crate::services::flow::workflow::engine::RunContext;
use crate::services::flow::workflow::engine::nodes::extract_node_op_config;
use crate::services::flow::workflow::types::{NodeExecutionOutput, WorkflowNode};
use crate::utils::types::origin::Origin;

/// Whether a mounted remote is the one this node would create: started by this
/// node, or the same remote already at the same mount point. Anything else at
/// that mount point is a conflict for `mount_remote` to report.
fn is_own_mount(
    mounted: &crate::utils::types::remotes::MountedRemote,
    workflow_id: &str,
    node_id: &str,
    params: &MountParams,
) -> bool {
    (mounted.workflow_id.as_deref() == Some(workflow_id)
        && mounted.node_id.as_deref() == Some(node_id))
        || (!params.mount_point.is_empty()
            && mounted.mount_point == params.mount_point
            && mounted.fs.trim_end_matches('/') == params.source.trim_end_matches('/'))
}

/// Resolves a string value first from an upstream node's execution results, or falls back to the current node's config.
fn resolve_target_or_config(
    target_node_id: &str,
    node_results: &HashMap<String, Value>,
    config: &Value,
    primary_keys: &[&str],
    fallback_keys: &[&str],
) -> String {
    if !target_node_id.is_empty()
        && let Some(target_result) = node_results.get(target_node_id)
    {
        for key in primary_keys {
            if let Some(val) = target_result.get(*key).and_then(Value::as_str)
                && !val.is_empty()
            {
                return val.to_string();
            }
        }
    }

    for key in fallback_keys {
        if let Some(val) = config.get(*key).and_then(Value::as_str)
            && !val.is_empty()
        {
            return val.to_string();
        }
    }

    String::new()
}

/// Mounts a remote for the run, unless this node already did.
pub(crate) async fn mount_node(
    ctx: &RunContext,
    node: &WorkflowNode,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let RunContext { app, backend, .. } = ctx;
    let workflow = &ctx.snapshot.definition;
    let op = extract_node_op_config(config);
    let mut mount_params =
        MountParams::from_config(op.remote.to_string(), op.config, &op.empty_settings)?;

    mount_params.backend = Some(backend.clone());
    mount_params.origin = Some(Origin::Flow);
    mount_params.workflow_id = Some(workflow.id.clone());
    mount_params.node_id = Some(node.id.clone());
    mount_params.execute_id = Some(ctx.run_id.clone());

    let backend_manager = app.state::<BackendManager>();
    let is_already_mounted = {
        let mounted = backend_manager
            .remote_cache_for(&backend.name)
            .get_mounted_remotes()
            .await;
        mounted
            .iter()
            .any(|m| is_own_mount(m, &workflow.id, &node.id, &mount_params))
    };

    if is_already_mounted {
        info!(
            "Remote '{}' or mount point '{}' is already mounted for node '{}'. Continuing workflow.",
            op.remote, mount_params.mount_point, node.id
        );
    } else {
        mount_remote(app.clone(), mount_params.clone()).await?;
    }
    let mut output = json!({
        "mounted": true,
        "mountPoint": mount_params.mount_point,
        "remote": op.remote,
        "nodeId": node.id,
        "workflowId": workflow.id
    });
    if is_already_mounted {
        output["alreadyMounted"] = json!(true);
    }
    Ok(NodeExecutionOutput::new(output))
}

/// Unmounts the mount of an earlier node, or the mount point written in the config.
pub(crate) async fn unmount_node(
    ctx: &RunContext,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let target_node_id = config
        .get("targetNodeId")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let (mount_point, remote_name) = {
        let results = ctx.node_results.read();
        (
            resolve_target_or_config(
                target_node_id,
                &results,
                config,
                &["mountPoint"],
                &["mountPoint"],
            ),
            resolve_target_or_config(
                target_node_id,
                &results,
                config,
                &["remote", "remoteName"],
                &["remoteName", "remote"],
            ),
        )
    };

    if mount_point.is_empty() {
        return Err(crate::localized_error!(
            "backendErrors.workflow.missingMountPoint"
        ));
    }

    crate::rclone::commands::mount::unmount_remote_on_backend(
        ctx.app.clone(),
        ctx.backend.clone(),
        mount_point.clone(),
        remote_name,
    )
    .await?;

    Ok(NodeExecutionOutput::new(json!({
        "unmounted": true,
        "mountPoint": mount_point,
        "targetNodeId": target_node_id
    })))
}

/// Starts serving a remote for the run, unless this node already does.
pub(crate) async fn serve_node(
    ctx: &RunContext,
    node: &WorkflowNode,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let RunContext { app, backend, .. } = ctx;
    let workflow = &ctx.snapshot.definition;
    let op = extract_node_op_config(config);
    let mut serve_params =
        ServeParams::from_config(op.remote.to_string(), op.config, &op.empty_settings)?;

    serve_params.backend = Some(backend.clone());
    serve_params.origin = Some(Origin::Flow);
    serve_params.workflow_id = Some(workflow.id.clone());
    serve_params.node_id = Some(node.id.clone());
    serve_params.execute_id = Some(ctx.run_id.clone());

    let backend_manager = app.state::<BackendManager>();
    let existing_serve = {
        let serves = backend_manager
            .remote_cache_for(&backend.name)
            .get_serves()
            .await;
        serves
            .iter()
            .find(|s| {
                s.workflow_id.as_deref() == Some(&workflow.id)
                    && s.node_id.as_deref() == Some(&node.id)
            })
            .cloned()
    };

    if let Some(s) = existing_serve {
        let addr = s
            .params
            .get("addr")
            .and_then(|v| v.as_str())
            .unwrap_or(&s.addr)
            .to_string();
        info!(
            "Remote '{}' is already being served for node '{}' (id: {}). Continuing workflow.",
            op.remote, node.id, s.id
        );
        Ok(NodeExecutionOutput::new(json!({
            "served": true,
            "alreadyServing": true,
            "id": s.id,
            "addr": addr,
            "remote": op.remote,
            "nodeId": node.id,
            "workflowId": workflow.id
        })))
    } else {
        let serve_res = start_serve(app.clone(), serve_params).await?;
        Ok(NodeExecutionOutput::new(json!({
            "served": true,
            "id": serve_res.id,
            "addr": serve_res.addr,
            "remote": op.remote,
            "nodeId": node.id,
            "workflowId": workflow.id
        })))
    }
}

/// Stops the serve of an earlier node, a serve by id, or every serve of a remote.
pub(crate) async fn stop_serve_node(
    ctx: &RunContext,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let RunContext { app, backend, .. } = ctx;
    let target_node_id = config
        .get("targetNodeId")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let (server_id, remote_name) = {
        let results = ctx.node_results.read();
        (
            resolve_target_or_config(
                target_node_id,
                &results,
                config,
                &["id", "serverId"],
                &["serverId", "id"],
            ),
            resolve_target_or_config(
                target_node_id,
                &results,
                config,
                &["remote", "remoteName"],
                &["remoteName", "remote"],
            ),
        )
    };

    if !server_id.is_empty() {
        crate::rclone::commands::serve::stop_serve_on_backend(
            app.clone(),
            backend.clone(),
            server_id.clone(),
            remote_name,
        )
        .await?;
        return Ok(NodeExecutionOutput::new(json!({
            "stopped": true,
            "serverId": server_id,
            "targetNodeId": target_node_id
        })));
    }
    if remote_name.is_empty() {
        return Err(crate::localized_error!(
            "backendErrors.workflow.missingStopServeTarget"
        ));
    }

    let backend_manager = app.state::<BackendManager>();
    let prefix = format!("{remote_name}:");
    let matching_serves: Vec<_> = backend_manager
        .remote_cache_for(&backend.name)
        .get_serves()
        .await
        .into_iter()
        .filter(|s| {
            let fs = s
                .params
                .get("fs")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            fs.starts_with(&prefix) || fs == remote_name
        })
        .collect();

    if matching_serves.is_empty() {
        info!("No active serves found for remote '{remote_name}' to stop");
    }
    let mut stopped_count = 0;
    for serve in matching_serves {
        if let Err(e) = crate::rclone::commands::serve::stop_serve_on_backend(
            app.clone(),
            backend.clone(),
            serve.id.clone(),
            remote_name.clone(),
        )
        .await
        {
            warn!("Failed stopping serve {} during workflow: {e}", serve.id);
        } else {
            stopped_count += 1;
        }
    }
    Ok(NodeExecutionOutput::new(json!({
        "stopped": true,
        "remoteName": remote_name,
        "count": stopped_count
    })))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::{Value, json};

    use super::*;

    use crate::rclone::commands::mount::MountParams;

    #[test]
    fn test_target_node_id_resolution_for_unmount_and_stop_serve() {
        let mut results = HashMap::new();
        results.insert(
            "node_mount_1".to_string(),
            json!({
                "mounted": true,
                "mountPoint": "/mnt/cloud",
                "remote": "gdrive",
                "nodeId": "node_mount_1"
            }),
        );
        results.insert(
            "node_serve_1".to_string(),
            json!({
                "served": true,
                "id": "http-123",
                "addr": "127.0.0.1:8080",
                "remote": "dropbox",
                "nodeId": "node_serve_1"
            }),
        );

        // Verify unmount resolution from node_mount_1
        let unmount_target = "node_mount_1";
        let target_result = results
            .get(unmount_target)
            .expect("Target mount node exists");
        let mount_point = target_result
            .get("mountPoint")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let remote = target_result
            .get("remote")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert_eq!(mount_point, "/mnt/cloud");
        assert_eq!(remote, "gdrive");

        // Verify stop_serve resolution from node_serve_1
        let serve_target = "node_serve_1";
        let target_serve = results.get(serve_target).expect("Target serve node exists");
        let server_id = target_serve
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let serve_remote = target_serve
            .get("remote")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert_eq!(server_id, "http-123");
        assert_eq!(serve_remote, "dropbox");
    }

    #[test]
    fn test_resolve_target_or_config_helper() {
        let mut results = HashMap::new();
        results.insert(
            "node-mount".to_string(),
            json!({
                "mountPoint": "/mnt/drive",
                "remote": "gdrive"
            }),
        );

        let config = json!({
            "targetNodeId": "node-mount",
            "mountPoint": "/fallback/drive",
            "remoteName": "fallback-remote"
        });

        // 1. Upstream node result matches
        let mp = resolve_target_or_config(
            "node-mount",
            &results,
            &config,
            &["mountPoint"],
            &["mountPoint"],
        );
        let rem = resolve_target_or_config(
            "node-mount",
            &results,
            &config,
            &["remote", "remoteName"],
            &["remoteName", "remote"],
        );
        assert_eq!(mp, "/mnt/drive");
        assert_eq!(rem, "gdrive");

        // 2. Upstream node missing -> fallback to config
        let mp_fallback = resolve_target_or_config(
            "node-nonexistent",
            &results,
            &config,
            &["mountPoint"],
            &["mountPoint"],
        );
        assert_eq!(mp_fallback, "/fallback/drive");

        // 3. No target id -> fallback to config
        let rem_fallback = resolve_target_or_config(
            "",
            &results,
            &config,
            &["remote", "remoteName"],
            &["remoteName", "remote"],
        );
        assert_eq!(rem_fallback, "fallback-remote");
    }

    #[test]
    fn only_a_mount_this_node_would_create_counts_as_already_mounted() {
        use crate::utils::types::remotes::MountedRemote;
        let params = MountParams::from_config(
            "drive".into(),
            &json!({"fs": "drive:photos", "mountPoint": "/mnt/photos"}),
            &json!({"name": "drive"}),
        )
        .unwrap();
        let at = |fs: &str, mount_point: &str| MountedRemote::new(fs, mount_point);

        assert!(is_own_mount(
            &at("drive:photos", "/mnt/photos"),
            "wf",
            "n",
            &params
        ));
        assert!(is_own_mount(
            &at("drive:photos/", "/mnt/photos"),
            "wf",
            "n",
            &params
        ));
        // Another remote holding the same mount point is a conflict, not a match.
        assert!(!is_own_mount(
            &at("other:photos", "/mnt/photos"),
            "wf",
            "n",
            &params
        ));
        assert!(!is_own_mount(
            &at("drive:photos", "/mnt/elsewhere"),
            "wf",
            "n",
            &params
        ));

        let mut earlier_run = at("drive:photos", "/mnt/elsewhere");
        earlier_run.workflow_id = Some("wf".into());
        earlier_run.node_id = Some("n".into());
        assert!(is_own_mount(&earlier_run, "wf", "n", &params));
        assert!(!is_own_mount(&earlier_run, "wf", "other-node", &params));
    }
}
