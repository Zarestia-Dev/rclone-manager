use log::debug;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::rclone::commands::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};
use crate::utils::rclone::endpoints::core;
use crate::utils::types::core::RcloneState;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;

#[tauri::command]
pub async fn archive_create(
    app: AppHandle,
    source: String,
    destination: String,
    format: Option<String>,
    prefix: Option<String>,
    full_path: Option<bool>,
    include: Option<Vec<String>>,
) -> Result<Value, String> {
    debug!(
        "archive_create: source={source} destination={destination} include={:?}",
        include
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let rclone_state = app.state::<RcloneState>();
    let client = &rclone_state.client;

    let mut args = vec!["create".to_string(), source.clone(), destination.clone()];

    if let Some(f) = format {
        args.push("--format".to_string());
        args.push(f);
    }
    if let Some(p) = prefix {
        args.push("--prefix".to_string());
        args.push(p);
    }
    if full_path.unwrap_or(false) {
        args.push("--full-path".to_string());
    }
    if let Some(inc) = include {
        for i in inc {
            args.push("--include".to_string());
            args.push(i);
        }
    }

    let group_id = format!("archive_create_{}", uuid::Uuid::new_v4().simple());
    let os = backend_manager.get_runtime_os(&backend.name).await;
    let mut payload = backend.build_core_command_payload("archive", args, true, os);

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("_group".to_string(), json!(group_id));
    }

    let metadata = JobMetadata {
        remote_name: destination.clone(),
        job_type: JobType::ArchiveCreate,
        source: source.clone(),
        destination: destination.clone(),
        profile: None,
        origin: Some(Origin::FileManager),
        group: Some(group_id),
        no_cache: false,
    };

    let (jobid, _response, _execute_id) = submit_job_with_options(
        app.clone(),
        client.clone(),
        backend.inject_auth(client.post(backend.url_for(core::COMMAND))),
        payload,
        metadata,
        SubmitJobOptions {
            wait_for_completion: false,
        },
    )
    .await?;

    Ok(json!({ "success": true, "jobid": jobid }))
}

#[tauri::command]
pub async fn archive_extract(
    app: AppHandle,
    source: String,
    destination: String,
) -> Result<Value, String> {
    debug!("archive_extract: source={source} destination={destination}");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let rclone_state = app.state::<RcloneState>();
    let client = &rclone_state.client;

    let args = vec!["extract".to_string(), source.clone(), destination.clone()];

    let group_id = format!("archive_extract_{}", uuid::Uuid::new_v4().simple());
    let os = backend_manager.get_runtime_os(&backend.name).await;
    let mut payload = backend.build_core_command_payload("archive", args, true, os);

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("_group".to_string(), json!(group_id));
    }

    let metadata = JobMetadata {
        remote_name: source.clone(),
        job_type: JobType::ArchiveExtract,
        source: source.clone(),
        destination: destination.clone(),
        profile: None,
        origin: Some(Origin::FileManager),
        group: Some(group_id),
        no_cache: false,
    };

    let (jobid, _response, _execute_id) = submit_job_with_options(
        app.clone(),
        client.clone(),
        backend.inject_auth(client.post(backend.url_for(core::COMMAND))),
        payload,
        metadata,
        SubmitJobOptions {
            wait_for_completion: false,
        },
    )
    .await?;

    Ok(json!({ "success": true, "jobid": jobid }))
}

#[tauri::command]
pub async fn archive_list(
    app: AppHandle,
    source: String,
    long: Option<bool>,
    plain: Option<bool>,
    files_only: Option<bool>,
    dirs_only: Option<bool>,
) -> Result<Value, String> {
    debug!("archive_list: source={source}");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let rclone_state = app.state::<RcloneState>();
    let client = &rclone_state.client;

    let mut args = vec!["list".to_string(), source];

    if long.unwrap_or(false) {
        args.push("--long".to_string());
    }
    if plain.unwrap_or(false) {
        args.push("--plain".to_string());
    }
    if files_only.unwrap_or(false) {
        args.push("--files-only".to_string());
    }
    if dirs_only.unwrap_or(false) {
        args.push("--dirs-only".to_string());
    }

    let os = backend_manager.get_runtime_os(&backend.name).await;
    let payload = backend.build_core_command_payload("archive", args, false, os);

    let response = backend
        .post_json(client, core::COMMAND, Some(&payload))
        .await
        .map_err(|e| format!("Failed to list archive: {e}"))?;

    let error = response
        .get("error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let result = response
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if error {
        return Err(format!("Archive list failed: {result}"));
    }

    // Since rclone doesn't return JSON for archive list, we return the raw string.
    // The frontend can parse it if needed (e.g. splitting by lines).
    Ok(json!({ "success": true, "output": result }))
}
