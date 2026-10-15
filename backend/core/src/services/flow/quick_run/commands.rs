//! Tauri commands for the Flow workspace Quick Run feature.
use crate::context::AppHandle;
use log::{info, warn};
use serde_json::json;

use crate::{
    rclone::commands::{
        common::parse_common_config,
        job::JobMetadata,
        mount::{MountParams, mount_remote},
        serve::{ServeParams, start_serve},
        sync::{lookup_dry_run, submit_transfer_batch},
    },
    services::{
        bridge,
        flow::quick_run::types::{QuickRun, QuickRunInput, StartQuickRunResponse},
        settings::AppSettingsManager,
    },
    utils::{
        constants::SUB_QUICK_RUNS,
        types::{
            events::UPDATE_TRAY_MENU,
            jobs::{JobStatus, JobType},
            origin::Origin,
            remotes::OperationType,
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
    let id = quick_run
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let record = QuickRun {
        id: id.clone(),
        name: quick_run.name,
        description: quick_run.description,
        operation_type: quick_run.operation_type,
        remote_name: quick_run.remote_name,
        config: quick_run.config,
    };

    save_quick_run(&manager, &record)?;
    bridge::emit(UPDATE_TRAY_MENU, ());
    sync_quick_run_automations(&app).await?;
    Ok(record)
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

    let mut existing =
        get_quick_run(&manager, id)?.ok_or_else(|| format!("Quick run '{id}' not found"))?;

    existing.name = quick_run.name;
    existing.description = quick_run.description;
    existing.operation_type = quick_run.operation_type;
    existing.remote_name = quick_run.remote_name;
    existing.config = quick_run.config;

    save_quick_run(&manager, &existing)?;
    bridge::emit(UPDATE_TRAY_MENU, ());
    sync_quick_run_automations(&app).await?;
    Ok(existing)
}

/// Delete a quick run record by ID.
pub async fn delete_quick_run(app: AppHandle, quick_run_id: String) -> Result<(), String> {
    info!("Deleting quick run: {quick_run_id}");
    let manager = app.state::<AppSettingsManager>();
    delete_quick_run_by_id(&manager, &quick_run_id)?;
    bridge::emit(UPDATE_TRAY_MENU, ());
    sync_quick_run_automations(&app).await?;
    Ok(())
}

pub async fn sync_quick_run_automations(app: &AppHandle) -> Result<(), String> {
    use crate::rclone::{backend::BackendManager, state::automations::AutomationsCache};
    use crate::services::automation::engine::apply_and_sync_automations;
    use crate::services::settings::AppSettingsManager;

    let manager = app.state::<AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();
    let backend_manager = app.state::<BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    let quick_runs = get_all_quick_runs_sync(&manager)?;
    cache
        .load_from_quick_runs(&quick_runs, &backend_name)
        .await?;
    apply_and_sync_automations(app).await
}

/// Start execution of a quick run.
pub async fn start_quick_run(
    app: AppHandle,
    quick_run_id: String,
    workflow_id: Option<String>,
    node_id: Option<String>,
) -> Result<StartQuickRunResponse, String> {
    let backend = app
        .state::<crate::rclone::backend::BackendManager>()
        .get_active()
        .await;
    start_quick_run_on_backend(app, backend, quick_run_id, workflow_id, node_id, None).await
}

pub(crate) async fn start_quick_run_on_backend(
    app: AppHandle,
    backend: crate::rclone::backend::types::Backend,
    quick_run_id: String,
    workflow_id: Option<String>,
    node_id: Option<String>,
    execute_id: Option<String>,
) -> Result<StartQuickRunResponse, String> {
    info!("Starting quick run: {quick_run_id}");
    let manager = app.state::<AppSettingsManager>();

    let qr = get_quick_run(&manager, &quick_run_id)?
        .ok_or_else(|| format!("Quick run '{quick_run_id}' not found"))?;

    let execute_id = execute_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let start_time = chrono::Utc::now();
    let empty_settings = json!({"name": qr.remote_name.trim_end_matches(':')});

    if qr.operation_type == OperationType::Mount {
        let mut mount_params =
            MountParams::from_config(qr.remote_name.clone(), &qr.config, &empty_settings)?;
        let mount_point = mount_params.mount_point.clone();
        mount_params.backend = Some(backend.clone());
        mount_params.profile = None;
        mount_params.quick_run_id = Some(quick_run_id.clone());
        mount_params.workflow_id = workflow_id;
        mount_params.execute_id = Some(execute_id.clone());
        mount_params.origin = Some(Origin::QuickRun);

        mount_remote(app.clone(), mount_params).await?;

        return Ok(StartQuickRunResponse {
            execute_id,
            origin: Origin::QuickRun,
            operation_type: OperationType::Mount,
            remote_name: qr.remote_name,
            quick_run_id: Some(quick_run_id),
            profile: None,
            success: true,
            status: JobStatus::Running,
            error: None,
            start_time,
            job_id: None,
            serve_id: None,
            serve_addr: None,
            mount_point: Some(mount_point),
        });
    }

    if qr.operation_type == OperationType::Serve {
        let mut serve_params =
            ServeParams::from_config(qr.remote_name.clone(), &qr.config, &empty_settings)?;
        serve_params.backend = Some(backend.clone());
        serve_params.profile = None;
        serve_params.quick_run_id = Some(quick_run_id.clone());
        serve_params.workflow_id = workflow_id;
        serve_params.execute_id = Some(execute_id.clone());
        serve_params.origin = Some(Origin::QuickRun);

        let serve_res = start_serve(app.clone(), serve_params).await?;

        return Ok(StartQuickRunResponse {
            execute_id,
            origin: Origin::QuickRun,
            operation_type: OperationType::Serve,
            remote_name: qr.remote_name,
            quick_run_id: Some(quick_run_id),
            profile: None,
            success: true,
            status: JobStatus::Running,
            error: None,
            start_time,
            job_id: None,
            serve_id: Some(serve_res.id),
            serve_addr: Some(serve_res.addr),
            mount_point: None,
        });
    }

    let common = parse_common_config(&qr.config, &empty_settings)?;

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

    let metadata = JobMetadata::new(
        qr.remote_name.clone(),
        qr.operation_type.as_job_type().unwrap_or(JobType::Sync),
        common.source.clone(),
        common.dest.clone(),
    )
    .with_profile(None)
    .with_origin(Some(Origin::QuickRun))
    .with_dry_run(dry_run)
    .with_quick_run_id(Some(quick_run_id.clone()))
    .with_execute_id(Some(execute_id.clone()))
    .with_workflow_id(workflow_id)
    .with_node_id(node_id);

    let job_id_str = submit_transfer_batch(
        app.clone(),
        backend,
        qr.operation_type,
        target_pairs,
        &common,
        dry_run,
        metadata,
    )
    .await?;

    let job_id = job_id_str
        .parse::<u64>()
        .map_err(|e| format!("Invalid job ID returned by backend: {e}"))?;

    Ok(StartQuickRunResponse {
        execute_id,
        origin: Origin::QuickRun,
        operation_type: qr.operation_type,
        remote_name: qr.remote_name,
        quick_run_id: Some(quick_run_id),
        profile: None,
        success: true,
        status: JobStatus::Running,
        error: None,
        start_time,
        job_id: Some(job_id),
        serve_id: None,
        serve_addr: None,
        mount_point: None,
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
            if mount.quick_run_id.as_deref() == Some(&quick_run_id) {
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
            if serve.quick_run_id.as_deref() == Some(&quick_run_id) {
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
            if job.quick_run_id.as_deref() == Some(&quick_run_id)
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

pub fn get_all_quick_runs_sync(manager: &AppSettingsManager) -> Result<Vec<QuickRun>, String> {
    let sub = manager
        .sub_settings(SUB_QUICK_RUNS)
        .map_err(|e| e.to_string())?;

    let values = sub.get_all_values().unwrap_or_default();
    let mut list: Vec<QuickRun> = values
        .into_values()
        .filter_map(|v| serde_json::from_value::<QuickRun>(v).ok())
        .collect();

    list.sort_by_cached_key(|a| a.name.to_lowercase());
    Ok(list)
}

fn get_all_quick_runs(manager: &AppSettingsManager) -> Result<Vec<QuickRun>, String> {
    get_all_quick_runs_sync(manager)
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
        Err(_) => Ok(None),
    }
}

fn save_quick_run(manager: &AppSettingsManager, qr: &QuickRun) -> Result<(), String> {
    crate::services::automation::engine::validate_enabled_cron(
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

    let values = sub.get_all_values().unwrap_or_default();
    let mut deleted_ids = Vec::new();
    let clean_remote_name = remote_name.trim_end_matches(':');

    for (id, val) in values {
        if let Ok(qr) = serde_json::from_value::<QuickRun>(val)
            && qr.remote_name.trim_end_matches(':') == clean_remote_name
            && sub.delete(&id).is_ok()
        {
            deleted_ids.push(id);
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
            .with_quick_run_id(Some("another-preset".into()));
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
        let empty_settings = json!({});
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
            parse_common_config(&qr_config, &empty_settings).expect("Failed to parse config");
        assert_eq!(common.source, vec!["remote:bucket/source"]);
        assert_eq!(common.dest, "/local/target");
        assert!(common.vfs_options.is_none());
        assert!(common.filter_options.is_none());
        assert!(common.backend_options.is_none());
    }

    #[test]
    fn test_quick_run_with_cli_flags() {
        let empty_settings = json!({});
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
            parse_common_config(&qr_config, &empty_settings).expect("Failed to parse config");
        assert_eq!(common.source, vec!["remote:bucket/source"]);
        assert_eq!(common.dest, "/local/target");
        assert_eq!(
            common.rclone_config.get("value_of_rclone").unwrap(),
            "mapped_val"
        );
        assert_eq!(common.rclone_config.get("bwlimit").unwrap(), "10M");
        assert_eq!(common.rclone_config.get("dry_run").unwrap(), true);

        let body = crate::rclone::commands::sync::GenericTransferParams {
            source: common.first_source(),
            dest: common.dest.clone(),
            rclone_config: common.rclone_config.clone(),
            filter_options: common.filter_options.clone(),
            backend_options: common.backend_options.clone(),
            runtime_remote_options: common.runtime_remote_options.clone(),
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: None,
        }
        .to_rclone_body()
        .unwrap();

        let obj = body.as_object().unwrap();
        assert_eq!(obj.get("value_of_rclone").unwrap(), "mapped_val");
        assert_eq!(obj.get("bwlimit").unwrap(), "10M");
        assert_eq!(obj.get("dry_run").unwrap(), true);
    }
}
