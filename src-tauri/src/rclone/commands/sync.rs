use log::debug;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

use crate::utils::types::origin::Origin;
use crate::{
    rclone::backend::BackendManager,
    utils::{
        json_helpers::unwrap_nested_options,
        logging::log::log_operation,
        rclone::endpoints::sync,
        types::{core::RcloneState, jobs::JobType, logs::LogLevel, remotes::ProfileParams},
    },
};

use super::common::{fs_value_with_runtime_overrides, parse_common_config};
use super::job::{JobMetadata, submit_job};

// ============================================================================
// SHARED TYPES
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TransferType {
    Sync,
    Copy,
    Move,
    Bisync,
}

impl TransferType {
    pub fn as_str(&self) -> &'static str {
        match self {
            TransferType::Sync => "sync",
            TransferType::Copy => "copy",
            TransferType::Move => "move",
            TransferType::Bisync => "bisync",
        }
    }

    pub fn operation_name(&self) -> &'static str {
        match self {
            TransferType::Sync => "Sync operation",
            TransferType::Copy => "Copy operation",
            TransferType::Move => "Move operation",
            TransferType::Bisync => "Bisync operation",
        }
    }

    pub fn endpoint(&self) -> &'static str {
        match self {
            TransferType::Sync => sync::SYNC,
            TransferType::Copy => sync::COPY,
            TransferType::Move => sync::MOVE,
            TransferType::Bisync => sync::BISYNC,
        }
    }

    pub fn as_job_type(&self) -> JobType {
        match self {
            TransferType::Sync => JobType::Sync,
            TransferType::Copy => JobType::Copy,
            TransferType::Move => JobType::Move,
            TransferType::Bisync => JobType::Bisync,
        }
    }
}

/// Unified parameter structure for all transfer operations
#[derive(Debug, Clone)]
pub struct GenericTransferParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
    pub transfer_type: TransferType,
    pub origin: Option<crate::utils::types::origin::Origin>,
    pub no_cache: Option<bool>,
}

impl GenericTransferParams {
    pub fn to_rclone_body(&self) -> Value {
        let mut body = Map::new();
        let src_fs =
            fs_value_with_runtime_overrides(&self.source, self.runtime_remote_options.as_ref());
        let dst_fs =
            fs_value_with_runtime_overrides(&self.dest, self.runtime_remote_options.as_ref());

        // Bisync uses path1/path2, others use srcFs/dstFs
        if self.transfer_type == TransferType::Bisync {
            body.insert("path1".to_string(), src_fs);
            body.insert("path2".to_string(), dst_fs);
        } else {
            body.insert("srcFs".to_string(), src_fs);
            body.insert("dstFs".to_string(), dst_fs);
        }
        body.insert("_async".to_string(), Value::Bool(true));

        let mut opts = self.options.clone().unwrap_or_default();

        // Handle Special Top-Level Parameters
        let top_level_keys = [
            "createEmptySrcDirs", // sync, copy, move, bisync
            "deleteEmptySrcDirs", // move
            // bisync specific:
            "resync",
            "checkAccess",
            "checkFilename",
            "maxDelete",
            "force",
            "checkSync",
            "removeEmptyDirs",
            "filtersFile",
            "ignoreListingChecksum",
            "resilient",
            "workDir",
            "backupDir1",
            "backupDir2",
            "noCleanup",
            "dryRun",
        ];

        for key in top_level_keys {
            if let Some(val) = opts.remove(key) {
                match val {
                    Value::Bool(b) => {
                        if b {
                            body.insert(key.to_string(), Value::Bool(true));
                        }
                    }
                    _ => {
                        body.insert(key.to_string(), val);
                    }
                }
            }
        }

        // Merge Remaining Options into _config
        let config_map = merge_options(Some(opts), self.backend_options.clone());
        if !config_map.is_empty() {
            body.insert(
                "_config".to_string(),
                Value::Object(config_map.into_iter().collect()),
            );
        }

        // Add Filters
        if let Some(filters) = self.filter_options.clone() {
            let unwrapped_filters = unwrap_nested_options(filters);
            body.insert(
                "_filter".to_string(),
                Value::Object(unwrapped_filters.into_iter().collect()),
            );
        }

        Value::Object(body)
    }
}

// ============================================================================
// CORE LOGIC
// ============================================================================

/// Helper for merging options
fn merge_options(
    main_opts: Option<HashMap<String, Value>>,
    backend_opts: Option<HashMap<String, Value>>,
) -> HashMap<String, Value> {
    let main = main_opts.map(unwrap_nested_options);
    let backend = backend_opts.map(unwrap_nested_options);

    match (main, backend) {
        (Some(mut opts), Some(backend_unwrapped)) => {
            opts.extend(backend_unwrapped);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend_unwrapped)) => backend_unwrapped,
        (None, None) => HashMap::new(),
    }
}

/// Generic function to perform any transfer operation
async fn perform_transfer(app: AppHandle, params: GenericTransferParams) -> Result<u64, String> {
    let client = app.state::<RcloneState>().client.clone();
    debug!(
        "Starting {} with params: {:#?}",
        params.transfer_type.as_str(),
        params
    );

    let op_name = params.transfer_type.operation_name();

    // 1. Log Operation Start
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some(op_name.to_string()),
        format!(
            "Starting {} from {} to {}",
            params.transfer_type.as_str(),
            params.source,
            params.dest
        ),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
            "options": params.options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>()),
            "runtime_remote_options": params.runtime_remote_options.as_ref().map(|r| r.keys().collect::<Vec<_>>())
        })),
    );

    // 2. Build Request Body
    let body = params.to_rclone_body();

    // 4. Check for duplicates (Concurrency Control)
    let backend_manager = app.state::<BackendManager>();
    if backend_manager
        .job_cache
        .is_job_running(
            &params.remote_name,
            params.transfer_type.as_job_type(),
            params.profile.as_deref(),
        )
        .await
    {
        let profile_msg = params
            .profile
            .clone()
            .map(|p| format!(" (Profile: '{}')", p))
            .unwrap_or_default();

        let msg = format!(
            "Job '{}' is already running for '{}'{}",
            params.transfer_type.as_str(),
            params.remote_name,
            profile_msg
        );
        log::warn!("🚫 {}", msg);
        return Err(msg);
    }

    // 5. Submit Job
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(params.transfer_type.endpoint());

    let request = backend.inject_auth(client.post(&url));

    let (jobid, _, _) = submit_job(
        app,
        client.clone(),
        request,
        body,
        JobMetadata {
            remote_name: params.remote_name,
            job_type: params.transfer_type.as_job_type(),
            operation_name: op_name.to_string(),
            source: params.source,
            destination: params.dest,
            profile: params.profile,
            origin: params.origin,
            group: None, // Auto-generate from job_type/remote_name
            no_cache: params.no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

// ============================================================================
// PROFILE COMMANDS
// ============================================================================

/// Generic helper to load profile and run transfer
async fn load_profile_and_run(
    app: AppHandle,
    params: ProfileParams,
    config_key: &str,
    transfer_type: TransferType,
) -> Result<u64, String> {
    let (config, settings) = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        config_key,
    )
    .await?;

    let common = parse_common_config(&config, &settings, &params.remote_name).ok_or_else(|| {
        crate::localized_error!(
            "backendErrors.sync.configIncomplete",
            "profile" => &params.profile_name
        )
    })?;

    let transfer_params = GenericTransferParams {
        remote_name: params.remote_name.clone(),
        source: common.source,
        dest: common.dest,
        options: common.options,
        filter_options: common.filter_options,
        backend_options: common.backend_options,
        runtime_remote_options: common.runtime_remote_options,
        profile: Some(params.profile_name.clone()),
        transfer_type,
        origin: params.source.as_deref().map(Origin::parse),
        no_cache: params.no_cache,
    };

    perform_transfer(app, transfer_params).await
}

#[tauri::command]
pub async fn start_sync_profile(app: AppHandle, params: ProfileParams) -> Result<u64, String> {
    load_profile_and_run(app, params, "syncConfigs", TransferType::Sync).await
}

#[tauri::command]
pub async fn start_copy_profile(app: AppHandle, params: ProfileParams) -> Result<u64, String> {
    load_profile_and_run(app, params, "copyConfigs", TransferType::Copy).await
}

#[tauri::command]
pub async fn start_move_profile(app: AppHandle, params: ProfileParams) -> Result<u64, String> {
    load_profile_and_run(app, params, "moveConfigs", TransferType::Move).await
}

#[tauri::command]
pub async fn start_bisync_profile(app: AppHandle, params: ProfileParams) -> Result<u64, String> {
    load_profile_and_run(app, params, "bisyncConfigs", TransferType::Bisync).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_body_generation() {
        let params = GenericTransferParams {
            remote_name: "test".to_string(),
            source: "src:".to_string(),
            dest: "dst:".to_string(),
            options: Some(HashMap::from([
                ("dryRun".to_string(), Value::Bool(true)),
                ("transfers".to_string(), Value::Number(4.into())),
            ])),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            profile: Some("prof".to_string()),
            transfer_type: TransferType::Sync,
            origin: None,
            no_cache: None,
        };

        let body = params.to_rclone_body();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("srcFs").unwrap(), "src:");
        assert_eq!(obj.get("dstFs").unwrap(), "dst:");
        assert_eq!(obj.get("dryRun").unwrap(), true);

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("transfers").unwrap(), 4);
    }

    #[test]
    fn test_bisync_body_generation() {
        let params = GenericTransferParams {
            remote_name: "test".to_string(),
            source: "path1".to_string(),
            dest: "path2".to_string(),
            options: Some(HashMap::from([("resync".to_string(), Value::Bool(true))])),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            profile: Some("prof".to_string()),
            transfer_type: TransferType::Bisync,
            origin: None,
            no_cache: None,
        };

        let body = params.to_rclone_body();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("path1").unwrap(), "path1");
        assert_eq!(obj.get("path2").unwrap(), "path2");
        assert_eq!(obj.get("resync").unwrap(), true);
    }

    #[test]
    fn test_sync_body_generation_with_runtime_remote_overrides() {
        let params = GenericTransferParams {
            remote_name: "test".to_string(),
            source: "srcRemote:bucket/a".to_string(),
            dest: "dstRemote:bucket/b".to_string(),
            options: None,
            filter_options: None,
            backend_options: None,
            runtime_remote_options: Some(HashMap::from([
                (
                    "srcRemote".to_string(),
                    json!({ "type": "s3", "env_auth": true, "provider": "AWS" }),
                ),
                (
                    "dstRemote".to_string(),
                    json!({ "type": "s3", "env_auth": true, "provider": "AWS" }),
                ),
            ])),
            profile: Some("prof".to_string()),
            transfer_type: TransferType::Sync,
            origin: None,
            no_cache: None,
        };

        let body = params.to_rclone_body();
        let obj = body.as_object().unwrap();

        let src_fs = obj.get("srcFs").unwrap().as_object().unwrap();
        assert_eq!(src_fs.get("_name").unwrap(), "srcRemote");
        assert_eq!(src_fs.get("_root").unwrap(), "bucket/a");
        assert_eq!(src_fs.get("type").unwrap(), "s3");

        let dst_fs = obj.get("dstFs").unwrap().as_object().unwrap();
        assert_eq!(dst_fs.get("_name").unwrap(), "dstRemote");
        assert_eq!(dst_fs.get("_root").unwrap(), "bucket/b");
        assert_eq!(dst_fs.get("provider").unwrap(), "AWS");
    }
}
