use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use tauri::AppHandle;

use crate::utils::{
    json_helpers::unwrap_nested_options,
    rclone::endpoints::sync,
    types::{jobs::JobType, remotes::ProfileParams},
};

use super::common::{fs_value_with_runtime_overrides, parse_common_config};
use super::job::JobMetadata;

// ============================================================================
// SHARED TYPES
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum TransferType {
    Sync,
    Copy,
    Move,
    Bisync,
}

impl TransferType {
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
    pub source: String,
    pub dest: String,
    pub options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub transfer_type: TransferType,
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
        body.insert(
            "_path".to_string(),
            Value::String(self.transfer_type.endpoint().to_string()),
        );
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

// ============================================================================
// PROFILE COMMANDS
// ============================================================================

#[tauri::command]
pub async fn start_profile_batch(
    app: AppHandle,
    items: Vec<ProfileParams>,
    transfer_type: TransferType,
) -> Result<String, String> {
    let mut inputs = Vec::new();
    let mut metadata_list = Vec::new();

    let config_key = match transfer_type {
        TransferType::Sync => "syncConfigs",
        TransferType::Copy => "copyConfigs",
        TransferType::Move => "moveConfigs",
        TransferType::Bisync => "bisyncConfigs",
    };

    for params in items {
        let (config, settings) = crate::rclone::commands::common::resolve_profile_settings(
            &app,
            &params.remote_name,
            &params.profile_name,
            config_key,
        )
        .await
        .map_err(|e| format!("Failed to resolve profile {}: {}", params.profile_name, e))?;

        let common =
            parse_common_config(&config, &settings, &params.remote_name).ok_or_else(|| {
                format!(
                    "Profile {} configuration is incomplete",
                    params.profile_name
                )
            })?;

        let transfer_params = GenericTransferParams {
            source: common.source.clone(),
            dest: common.dest.clone(),
            options: common.options,
            filter_options: common.filter_options,
            backend_options: common.backend_options,
            runtime_remote_options: common.runtime_remote_options,
            transfer_type,
        };

        inputs.push(transfer_params.to_rclone_body());
        metadata_list.push(JobMetadata {
            remote_name: params.remote_name,
            job_type: transfer_type.as_job_type(),
            source: common.source,
            destination: common.dest,
            profile: Some(params.profile_name),
            origin: params.origin,
            group: None,
            no_cache: params.no_cache.unwrap_or(false),
        });
    }

    if inputs.is_empty() {
        return Err("No profiles to start".to_string());
    }

    // If only one item, we can just run it normally to get a u64 ID if needed?
    // Actually the user wants a batch job.
    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        Some(metadata_list),
        None,
        None,
        transfer_type.as_job_type(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn test_sync_body_generation() {
        let params = GenericTransferParams {
            source: "src:".to_string(),
            dest: "dst:".to_string(),
            options: Some(HashMap::from([
                ("dryRun".to_string(), json!(true)),
                ("transfers".to_string(), json!(4)),
            ])),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: TransferType::Sync,
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
            source: "path1".to_string(),
            dest: "path2".to_string(),
            options: Some(HashMap::from([("resync".to_string(), json!(true))])),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: TransferType::Bisync,
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
            transfer_type: TransferType::Sync,
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
