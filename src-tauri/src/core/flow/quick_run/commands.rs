//! Tauri commands for the Flow workspace Quick Run feature.

use log::{info, warn};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::{
    core::{
        flow::quick_run::types::{QuickRun, QuickRunInput, StartQuickRunResponse},
        settings::AppSettingsManager,
    },
    rclone::commands::{
        common::{FromConfig, is_directory, parse_common_config},
        job::{JobMetadata, submit_batch_job},
        mount::{MountParams, mount_remote},
        serve::{ServeParams, start_serve},
        sync::GenericTransferParams,
    },
    utils::{
        constants::SUB_QUICK_RUNS,
        types::{
            jobs::{JobStatus, JobType},
            origin::Origin,
            remotes::OperationType,
        },
    },
};

/// Get all quick runs.
#[tauri::command]
pub async fn list_quick_runs(app: AppHandle) -> Result<Vec<QuickRun>, String> {
    let manager = app.state::<AppSettingsManager>();
    get_all_quick_runs(&manager)
}

/// Create a new quick run record.
#[tauri::command]
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
    sync_quick_run_automations_bg(&app).await;
    Ok(record)
}

/// Update an existing quick run record.
#[tauri::command]
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
    sync_quick_run_automations_bg(&app).await;
    Ok(existing)
}

/// Delete a quick run record by ID.
#[tauri::command]
pub async fn delete_quick_run(app: AppHandle, quick_run_id: String) -> Result<(), String> {
    info!("Deleting quick run: {quick_run_id}");
    let manager = app.state::<AppSettingsManager>();
    delete_quick_run_by_id(&manager, &quick_run_id)?;
    sync_quick_run_automations_bg(&app).await;
    Ok(())
}

async fn sync_quick_run_automations_bg(app: &AppHandle) {
    use crate::core::automation::{engine::AutomationScheduler, watcher::WatcherManager};
    use crate::core::settings::AppSettingsManager;
    use crate::rclone::{backend::BackendManager, state::automations::AutomationsCache};

    let manager = app.state::<AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();
    let scheduler = app.state::<AutomationScheduler>();
    let watcher = app.state::<WatcherManager>();
    let backend_manager = app.state::<BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    if let Ok(quick_runs) = get_all_quick_runs_sync(&manager) {
        if let Ok(result) = cache
            .load_from_quick_runs(&quick_runs, &backend_name, Some(app))
            .await
        {
            let _ = scheduler.apply_cache_result(&result, cache).await;
        }
        let _ = watcher.sync_watchers(app.clone()).await;
    }

    #[cfg(all(desktop, feature = "tray"))]
    let _ = crate::core::tray::core::update_tray_menu(app.clone()).await;
}

/// Start execution of a quick run.
#[tauri::command]
pub async fn start_quick_run(
    app: AppHandle,
    quick_run_id: String,
) -> Result<StartQuickRunResponse, String> {
    info!("Starting quick run: {quick_run_id}");
    let manager = app.state::<AppSettingsManager>();

    let qr = get_quick_run(&manager, &quick_run_id)?
        .ok_or_else(|| format!("Quick run '{quick_run_id}' not found"))?;

    let execute_id = uuid::Uuid::new_v4().to_string();
    let start_time = chrono::Utc::now();
    let empty_settings = json!({});

    if qr.operation_type == OperationType::Mount {
        let mut mount_params =
            MountParams::from_config(qr.remote_name.clone(), &qr.config, &empty_settings)
                .ok_or_else(|| {
                    format!("Quick run '{}' mount configuration is incomplete", qr.name)
                })?;
        let mount_point = mount_params.mount_point.clone();
        mount_params.profile = None;
        mount_params.quick_run_id = Some(quick_run_id.clone());
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
            ServeParams::from_config(qr.remote_name.clone(), &qr.config, &empty_settings)
                .ok_or_else(|| {
                    format!("Quick run '{}' serve configuration is incomplete", qr.name)
                })?;
        serve_params.profile = None;
        serve_params.quick_run_id = Some(quick_run_id.clone());
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

    let common = parse_common_config(&qr.config, &empty_settings)
        .ok_or_else(|| format!("Quick run '{}' configuration is incomplete", qr.name))?;

    let dry_run = if qr.operation_type == OperationType::Bisync {
        common
            .rclone_config
            .get("dryRun")
            .or_else(|| common.rclone_config.get("dry_run"))
            .or_else(|| common.rclone_config.get("DryRun"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    } else {
        common
            .backend_options
            .as_ref()
            .and_then(|opts| {
                opts.get("DryRun")
                    .or_else(|| opts.get("dry_run"))
                    .or_else(|| opts.get("dryRun"))
            })
            .or_else(|| {
                common
                    .rclone_config
                    .get("DryRun")
                    .or_else(|| common.rclone_config.get("dry_run"))
                    .or_else(|| common.rclone_config.get("dryRun"))
            })
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };

    let mut inputs = Vec::new();
    for source in &common.source {
        let is_dir = is_directory(&app, source, common.runtime_remote_options.as_ref())
            .await
            .unwrap_or(true);

        let body = GenericTransferParams {
            source: source.clone(),
            dest: common.dest.clone(),
            rclone_config: common.rclone_config.clone(),
            filter_options: common.filter_options.clone(),
            backend_options: common.backend_options.clone(),
            runtime_remote_options: common.runtime_remote_options.clone(),
            transfer_type: qr.operation_type,
            is_dir,
        }
        .to_rclone_body()
        .map_err(|e| format!("Body generation error: {e}"))?;

        inputs.push(body);
    }

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
    .with_execute_id(Some(execute_id.clone()));

    let job_id_str = submit_batch_job(app.clone(), inputs, metadata).await?;

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
#[tauri::command]
pub async fn stop_quick_run(
    app: AppHandle,
    quick_run_id: String,
    job_id: Option<u64>,
) -> Result<(), String> {
    info!("Stopping quick run: {quick_run_id} (job_id: {job_id:?})");
    let manager = app.state::<AppSettingsManager>();

    let qr = get_quick_run(&manager, &quick_run_id)?
        .ok_or_else(|| format!("Quick run '{quick_run_id}' not found"))?;

    let empty_settings = json!({});

    if qr.operation_type == OperationType::Mount {
        let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
        let mounted = backend_manager.remote_cache.get_mounted_remotes().await;
        if let Some(m) = mounted
            .iter()
            .find(|m| m.quick_run_id.as_deref() == Some(&quick_run_id))
        {
            let _ = crate::rclone::commands::mount::unmount_remote(
                app.clone(),
                m.mount_point.clone(),
                qr.remote_name.clone(),
            )
            .await;
        } else if let Some(common) = parse_common_config(&qr.config, &empty_settings) {
            let mount_point = common.dest;
            if !mount_point.is_empty() {
                let _ = crate::rclone::commands::mount::unmount_remote(
                    app.clone(),
                    mount_point,
                    qr.remote_name.clone(),
                )
                .await;
            }
        }
    } else if qr.operation_type == OperationType::Serve {
        let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
        let running_serves = backend_manager.remote_cache.get_serves().await;
        for s in running_serves {
            if s.quick_run_id.as_deref() == Some(&quick_run_id) {
                let _ = crate::rclone::commands::serve::stop_serve(
                    app.clone(),
                    s.id,
                    qr.remote_name.clone(),
                )
                .await;
            }
        }
    } else {
        let mut job_ids_to_stop = Vec::new();

        if let Some(jid) = job_id {
            job_ids_to_stop.push(jid);
        }

        let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
        let running_jobs = backend_manager.job_cache.get_jobs().await;

        for j in running_jobs {
            if j.quick_run_id.as_deref() == Some(&quick_run_id)
                && j.status == JobStatus::Running
                && !job_ids_to_stop.contains(&j.jobid)
            {
                job_ids_to_stop.push(j.jobid);
            }
        }

        if job_ids_to_stop.is_empty() {
            warn!(
                "No running jobs found to stop for quick run '{quick_run_id}' ({})",
                qr.name
            );
        }

        for jid in job_ids_to_stop {
            info!("Stopping quick run job {jid} for {quick_run_id}");
            let res =
                crate::rclone::commands::job::stop_job(app.clone(), jid, qr.remote_name.clone())
                    .await;
            if let Err(e) = res {
                warn!("Failed to stop job {jid} for quick run {quick_run_id}: {e}");
            }
        }
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

    list.sort_by_key(|a| a.name.to_lowercase());
    Ok(list)
}

fn get_all_quick_runs(manager: &AppSettingsManager) -> Result<Vec<QuickRun>, String> {
    get_all_quick_runs_sync(manager)
}

fn get_quick_run(manager: &AppSettingsManager, id: &str) -> Result<Option<QuickRun>, String> {
    let sub = manager
        .sub_settings(SUB_QUICK_RUNS)
        .map_err(|e| e.to_string())?;

    match sub.get::<QuickRun>(id) {
        Ok(qr) => Ok(Some(qr)),
        Err(_) => Ok(None),
    }
}

fn save_quick_run(manager: &AppSettingsManager, qr: &QuickRun) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::settings::schema::AppSettings;
    use crate::utils::types::remotes::OperationType;
    use serde_json::json;
    use tempfile::TempDir;

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
}
