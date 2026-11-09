//! Tauri commands for the Flow workspace Quick Run feature.
use crate::context::AppHandle;
use log::{info, warn};
use serde_json::json;

use crate::{
    rclone::commands::{
        common::parse_common_config,
        job::JobMetadata,
        job_chain::ChainMode,
        mount::{MountParams, mount_remote},
        serve::{ServeParams, start_serve},
        sync::{lookup_dry_run, submit_transfer_batch},
    },
    services::{
        flow::quick_run::types::{QuickRun, QuickRunInput},
        settings::AppSettingsManager,
    },
    utils::{
        constants::SUB_QUICK_RUNS,
        types::{
            jobs::{JobStatus, JobType},
            origin::Origin,
            remotes::{OperationExecutionResult, OperationType},
            starter::{self, Starter, WorkflowRun},
        },
    },
};

/// Get all quick runs.
pub async fn list_quick_runs(app: AppHandle) -> Result<Vec<QuickRun>, String> {
    let manager = app.state::<AppSettingsManager>();
    get_all_quick_runs(&manager)
}

/// Create a new quick run record.
pub async fn create_quick_run(
    app: AppHandle,
    quick_run: QuickRunInput,
) -> Result<QuickRun, String> {
    info!("Creating quick run: {}", quick_run.name);
    let manager = app.state::<AppSettingsManager>();
    let record = new_record(quick_run);

    save_quick_run(&manager, &record)?;
    quick_run_changed(&app, &record.id).await?;
    Ok(record)
}

/// A new record always gets a fresh id: an id sent with a create must not overwrite an
/// existing quick run (that is what `update_quick_run` is for).
fn new_record(input: QuickRunInput) -> QuickRun {
    QuickRun {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name,
        description: input.description,
        operation_type: input.operation_type,
        remote_name: input.remote_name,
        config: input.config,
    }
}

/// Drops the cached snapshot of a quick run and re-reads the automations after it changed.
async fn quick_run_changed(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_quick_run(id);
    }
    crate::services::automation::commands::sync_flow_automations(app).await
}

/// Update an existing quick run record.
pub async fn update_quick_run(
    app: AppHandle,
    quick_run: QuickRunInput,
) -> Result<QuickRun, String> {
    let manager = app.state::<AppSettingsManager>();
    let id = quick_run
        .id
        .as_deref()
        .ok_or_else(|| "Missing quick run ID for update".to_string())?;

    info!("Updating quick run: {id}");

    let mut existing = get_quick_run(&manager, id)?.ok_or_else(
        || crate::localized_error!("backendErrors.automation.quickRunNotFound", "id" => id),
    )?;

    existing.name = quick_run.name;
    existing.description = quick_run.description;
    existing.operation_type = quick_run.operation_type;
    existing.remote_name = quick_run.remote_name;
    existing.config = quick_run.config;

    save_quick_run(&manager, &existing)?;
    quick_run_changed(&app, &existing.id).await?;
    Ok(existing)
}

/// Delete a quick run record by ID.
pub async fn delete_quick_run(app: AppHandle, quick_run_id: String) -> Result<(), String> {
    info!("Deleting quick run: {quick_run_id}");
    let manager = app.state::<AppSettingsManager>();
    delete_quick_run_by_id(&manager, &quick_run_id)?;
    quick_run_changed(&app, &quick_run_id).await
}

/// Start execution of a quick run.
pub async fn start_quick_run(
    app: AppHandle,
    quick_run_id: String,
) -> Result<OperationExecutionResult, String> {
    let backend = app
        .state::<crate::rclone::backend::BackendManager>()
        .get_active()
        .await;
    start_quick_run_on_backend(app, backend, quick_run_id, None).await
}

pub(crate) async fn start_quick_run_on_backend(
    app: AppHandle,
    backend: crate::rclone::backend::types::Backend,
    quick_run_id: String,
    execute_id: Option<String>,
) -> Result<OperationExecutionResult, String> {
    let qr = crate::services::automation::runtime::quick_run(&app, &quick_run_id)?;
    start_quick_run_snapshot(app, backend, qr, None, execute_id).await
}

pub(crate) async fn start_quick_run_snapshot(
    app: AppHandle,
    backend: crate::rclone::backend::types::Backend,
    qr: QuickRun,
    workflow_run: Option<WorkflowRun>,
    execute_id: Option<String>,
) -> Result<OperationExecutionResult, String> {
    info!("Starting quick run: {}", qr.id);
    let starter = Starter::quick_run(qr.id.clone(), qr.name.clone(), workflow_run);
    let origin = Origin::of_work(None, Some(&starter));
    let execute_id = execute_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let start_time = chrono::Utc::now();
    // The parsers read the owning remote's name from here; a quick run has no other settings.
    let owner_settings = json!({"name": qr.remote_name.trim_end_matches(':')});
    // What every kind of run reports; each branch adds the handle of what it started.
    let started = OperationExecutionResult {
        execute_id: execute_id.clone(),
        origin,
        operation_type: qr.operation_type,
        remote_name: qr.remote_name.clone(),
        starter: Some(starter.clone()),
        success: true,
        status: JobStatus::Running,
        error: None,
        start_time,
        job_id: None,
        serve_id: None,
        serve_addr: None,
        mount_point: None,
    };

    if qr.operation_type == OperationType::Mount {
        let mut mount_params =
            MountParams::from_config(qr.remote_name.clone(), &qr.config, &owner_settings)?;
        let mount_point = mount_params.mount_point.clone();
        mount_params.backend = Some(backend.clone());
        mount_params.starter = Some(starter.clone());
        mount_params.execute_id = Some(execute_id.clone());

        mount_remote(app.clone(), mount_params).await?;

        return Ok(OperationExecutionResult {
            mount_point: Some(mount_point),
            ..started
        });
    }

    if qr.operation_type == OperationType::Serve {
        let mut serve_params =
            ServeParams::from_config(qr.remote_name.clone(), &qr.config, &owner_settings)?;
        serve_params.backend = Some(backend.clone());
        serve_params.starter = Some(starter.clone());
        serve_params.execute_id = Some(execute_id.clone());

        let serve_res = start_serve(app.clone(), serve_params).await?;

        return Ok(OperationExecutionResult {
            serve_id: Some(serve_res.id),
            serve_addr: Some(serve_res.addr),
            ..started
        });
    }

    let common = parse_common_config(&qr.config, &owner_settings)?;

    let dry_run = lookup_dry_run(
        &common.rclone_config,
        common.backend_options.as_ref(),
        qr.operation_type,
    );

    let target_pairs: Vec<(String, String)> = common
        .source
        .iter()
        .map(|s| (s.clone(), common.dest.clone()))
        .collect();

    // A workflow follows the last job; the UI and automations must not wait for the chain.
    let chain = if starter.workflow_run().is_some() {
        ChainMode::Foreground
    } else {
        ChainMode::Background
    };
    let metadata = JobMetadata::new(
        qr.remote_name.clone(),
        qr.operation_type.as_job_type().unwrap_or(JobType::Sync),
        common.source.clone(),
        common.dest.clone(),
    )
    .with_starter(Some(starter.clone()))
    .with_dry_run(dry_run)
    .with_execute_id(Some(execute_id.clone()));

    let job_id_str = submit_transfer_batch(
        app.clone(),
        backend,
        qr.operation_type,
        target_pairs,
        &common,
        chain,
        metadata,
    )
    .await?;

    let job_id = job_id_str
        .parse::<u64>()
        .map_err(|e| format!("Invalid job ID returned by backend: {e}"))?;

    Ok(OperationExecutionResult {
        job_id: Some(job_id),
        ..started
    })
}

/// Stop execution of a running quick run.
pub async fn stop_quick_run(
    app: AppHandle,
    quick_run_id: String,
    job_id: Option<u64>,
) -> Result<(), String> {
    let manager = app.state::<crate::rclone::backend::BackendManager>();
    let mut stopped_any = false;
    // The preset can be edited or deleted after starting. Its live resources,
    // rather than today's definition or UI selection, identify what to stop.
    for info in manager.list_all().await {
        let Some(backend) = manager.get(&info.name).await else {
            continue;
        };
        let cache = manager.remote_cache_for(&backend.name);
        for mount in cache.get_mounted_remotes().await {
            if starter::quick_run_id(mount.starter.as_ref()) == Some(quick_run_id.as_str()) {
                crate::rclone::commands::mount::unmount_remote_on_backend(
                    app.clone(),
                    backend.clone(),
                    mount.mount_point,
                    mount.fs,
                )
                .await?;
                stopped_any = true;
            }
        }
        for serve in cache.get_serves().await {
            if starter::quick_run_id(serve.starter.as_ref()) == Some(quick_run_id.as_str()) {
                let remote = serve
                    .params
                    .get("fs")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                crate::rclone::commands::serve::stop_serve_on_backend(
                    app.clone(),
                    backend.clone(),
                    serve.id,
                    remote,
                )
                .await?;
                stopped_any = true;
            }
        }
        for job in manager.job_cache_for(&backend.name).get_active_jobs().await {
            if starter::quick_run_id(job.starter.as_ref()) == Some(quick_run_id.as_str())
                && job_id.is_none_or(|id| id == job.jobid)
            {
                crate::rclone::commands::job::stop_job_on_backend(
                    app.clone(),
                    backend.clone(),
                    job.jobid,
                    job.remote_name,
                )
                .await?;
                stopped_any = true;
            }
        }
    }
    if !stopped_any {
        warn!("No running resources found for quick run '{quick_run_id}'");
    }
    Ok(())
}

// ── Persistence Helpers ──────────────────────────────────────────────────

pub fn get_all_quick_runs(manager: &AppSettingsManager) -> Result<Vec<QuickRun>, String> {
    let sub = manager
        .sub_settings(SUB_QUICK_RUNS)
        .map_err(|e| e.to_string())?;

    let values = sub.get_all_values().map_err(|error| error.to_string())?;
    let mut list: Vec<QuickRun> = crate::utils::json_helpers::decode_valid(values, "quick run");

    list.sort_by_cached_key(|a| a.name.to_lowercase());
    Ok(list)
}

pub(crate) fn get_quick_run(
    manager: &AppSettingsManager,
    id: &str,
) -> Result<Option<QuickRun>, String> {
    let sub = manager
        .sub_settings(SUB_QUICK_RUNS)
        .map_err(|e| e.to_string())?;

    match sub.get::<QuickRun>(id) {
        Ok(qr) => Ok(Some(qr)),
        Err(rcman::Error::SubSettingsEntryNotFound(_)) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn save_quick_run(manager: &AppSettingsManager, qr: &QuickRun) -> Result<(), String> {
    crate::utils::cron::validate_enabled_cron(
        qr.is_cron_enabled(),
        qr.cron_expression().as_deref(),
    )?;
    let sub = manager
        .sub_settings(SUB_QUICK_RUNS)
        .map_err(|e| e.to_string())?;

    sub.set(&qr.id, qr)
        .map_err(|e| format!("Failed to save quick run: {e}"))
}

fn delete_quick_run_by_id(manager: &AppSettingsManager, id: &str) -> Result<(), String> {
    let sub = manager
        .sub_settings(SUB_QUICK_RUNS)
        .map_err(|e| e.to_string())?;

    sub.delete(id)
        .map_err(|e| format!("Failed to delete quick run: {e}"))
}

/// Delete all quick runs associated with a remote.
pub fn delete_quick_runs_for_remote(
    manager: &AppSettingsManager,
    remote_name: &str,
) -> Result<Vec<String>, String> {
    let sub = manager
        .sub_settings(SUB_QUICK_RUNS)
        .map_err(|e| e.to_string())?;

    let values = sub.get_all_values().map_err(|error| error.to_string())?;
    let mut deleted_ids = Vec::new();
    let clean_remote_name = remote_name.trim_end_matches(':');

    for (id, val) in values {
        let Ok(qr) = serde_json::from_value::<QuickRun>(val) else {
            continue;
        };
        if qr.remote_name.trim_end_matches(':') != clean_remote_name {
            continue;
        }
        // The caller must still refresh what did get deleted, so a failure is logged, not returned.
        match sub.delete(&id) {
            Ok(()) => deleted_ids.push(id),
            Err(error) => {
                warn!("Could not delete quick run '{id}' of remote '{remote_name}': {error}")
            }
        }
    }

    Ok(deleted_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::settings::schema::AppSettings;
    use crate::utils::types::remotes::OperationType;
    use serde_json::json;
    use tempfile::TempDir;

    #[tokio::test]
    async fn stopping_a_missing_preset_does_not_cancel_an_unrelated_job_with_the_same_id() {
        use crate::rclone::backend::BackendManager;
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        let manager = app.state::<BackendManager>();
        let jobs = manager.job_cache().await;
        let metadata = JobMetadata::new("drive", JobType::Copy, vec!["src".into()], "dst")
            .with_starter(Some(Starter::quick_run("another-preset", "Another", None)));
        jobs.create_job(7, metadata, "Local".into()).await;

        // There is no settings manager: a deleted preset's definition must not
        // be needed to locate (or rule out) its existing runtime resources.
        stop_quick_run(app.clone(), "deleted-preset".into(), Some(7))
            .await
            .unwrap();
        assert_eq!(jobs.get_job(7).await.unwrap().status, JobStatus::Running);
    }

    fn test_manager() -> (TempDir, AppSettingsManager) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<AppSettings>()
            .build();
        let manager = rcman::SettingsManager::new(config).expect("Failed to create manager");

        manager
            .register_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_QUICK_RUNS))
            .expect("Failed to register quick_runs sub-settings");

        (temp_dir, manager)
    }

    #[test]
    fn create_never_reuses_an_id_sent_by_the_client() {
        let input = QuickRunInput {
            id: Some("existing".into()),
            name: "Copy".into(),
            description: Some("d".into()),
            operation_type: OperationType::Copy,
            remote_name: "drive:".into(),
            config: json!({"app": {}, "rclone": {}}),
        };

        let first = new_record(input.clone());
        let second = new_record(input);

        assert_ne!(first.id, "existing");
        assert_ne!(first.id, second.id);
        assert_eq!(first.name, "Copy");
        assert_eq!(first.description.as_deref(), Some("d"));
        assert_eq!(first.operation_type, OperationType::Copy);
        assert_eq!(first.remote_name, "drive:");
    }

    #[test]
    fn deleting_a_remote_removes_only_its_quick_runs_with_or_without_the_colon() {
        let (_temp_dir, manager) = test_manager();
        let make = |id: &str, remote: &str| QuickRun {
            id: id.to_string(),
            name: id.to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: remote.to_string(),
            config: json!({"app": {}, "rclone": {}}),
        };
        for qr in [
            make("with-colon", "drive:"),
            make("without-colon", "drive"),
            make("other", "other:"),
        ] {
            save_quick_run(&manager, &qr).unwrap();
        }

        let mut deleted = delete_quick_runs_for_remote(&manager, "drive").unwrap();
        deleted.sort();

        assert_eq!(deleted, vec!["with-colon", "without-colon"]);
        let left: Vec<_> = get_all_quick_runs(&manager)
            .unwrap()
            .into_iter()
            .map(|qr| qr.id)
            .collect();
        assert_eq!(left, vec!["other"]);
    }

    #[test]
    fn test_quick_run_crud_helpers() {
        let (_temp_dir, manager) = test_manager();

        let qr = QuickRun {
            id: "qr-test-1".to_string(),
            name: "Test Run".to_string(),
            description: Some("Test description".to_string()),
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config: json!({"app": {}, "rclone": {}}),
        };

        // Initially empty
        let runs = get_all_quick_runs(&manager).unwrap();
        assert!(runs.is_empty());

        // Save
        save_quick_run(&manager, &qr).unwrap();

        // Get by ID
        let fetched = get_quick_run(&manager, "qr-test-1").unwrap();
        assert_eq!(fetched, Some(qr.clone()));

        // List
        let list = get_all_quick_runs(&manager).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "qr-test-1");

        // Delete
        delete_quick_run_by_id(&manager, "qr-test-1").unwrap();
        let after_delete = get_quick_run(&manager, "qr-test-1").unwrap();
        assert!(after_delete.is_none());
    }

    #[test]
    fn test_quick_run_config_isolation() {
        let owner_settings = json!({});
        let qr_config = json!({
            "app": {
                "autoStart": false,
                "cronEnabled": false,
                "watchEnabled": false
            },
            "rclone": {
                "srcFs": "remote:bucket/source",
                "dstFs": "/local/target",
                "dryRun": true
            }
        });

        let common =
            parse_common_config(&qr_config, &owner_settings).expect("Failed to parse config");
        assert_eq!(common.source, vec!["remote:bucket/source"]);
        assert_eq!(common.dest, "/local/target");
        assert!(common.vfs_options.is_none());
        assert!(common.filter_options.is_none());
        assert!(common.backend_options.is_none());
    }

    #[test]
    fn test_quick_run_with_cli_flags() {
        let owner_settings = json!({});
        let qr_config = json!({
            "app": {},
            "rclone": {
                "srcFs": "remote:bucket/source",
                "dstFs": "/local/target",
                "--value-of-rclone": "mapped_val",
                "--bwlimit": "10M",
                "--dry-run": true
            }
        });

        let common =
            parse_common_config(&qr_config, &owner_settings).expect("Failed to parse config");
        assert_eq!(common.source, vec!["remote:bucket/source"]);
        assert_eq!(common.dest, "/local/target");
        assert_eq!(
            common.rclone_config.get("value_of_rclone").unwrap(),
            "mapped_val"
        );
        assert_eq!(common.rclone_config.get("bwlimit").unwrap(), "10M");
        assert_eq!(common.rclone_config.get("dry_run").unwrap(), true);

        let body = crate::rclone::commands::sync::GenericTransferParams {
            source: common.source[0].clone(),
            dest: common.dest.clone(),
            rclone_config: common.rclone_config.clone(),
            filter_options: common.filter_options.clone(),
            backend_options: common.backend_options.clone(),
            runtime_remote_options: common.runtime_remote_options.clone(),
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: None,
        }
        .to_rclone_body(false)
        .unwrap();

        let obj = body.as_object().unwrap();
        assert_eq!(obj.get("value_of_rclone").unwrap(), "mapped_val");
        assert_eq!(obj.get("bwlimit").unwrap(), "10M");
        assert_eq!(obj.get("dry_run").unwrap(), true);
    }

    #[test]
    fn an_unreadable_quick_run_does_not_hide_the_others() {
        let (_temp_dir, manager) = test_manager();
        let valid: QuickRun = serde_json::from_value(serde_json::json!({
            "id": "valid", "name": "Valid", "operationType": "copy",
            "remoteName": "drive", "config": {"source": "/a", "dest": "/b"}
        }))
        .unwrap();
        manager
            .sub_settings(SUB_QUICK_RUNS)
            .unwrap()
            .set(&valid.id, &valid)
            .unwrap();
        manager
            .sub_settings(SUB_QUICK_RUNS)
            .unwrap()
            .set("damaged", &serde_json::json!({"operationType": 7}))
            .unwrap();

        let all = get_all_quick_runs(&manager).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "valid");
    }
}
