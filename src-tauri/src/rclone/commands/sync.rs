use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use tauri::AppHandle;

use crate::utils::{
    json_helpers::unwrap_nested_options,
    rclone::endpoints::sync,
    types::{jobs::JobType, remotes::ProfileParams},
};

use super::common::{fs_value_with_runtime_overrides, is_directory, parse_common_config, parse_fs};
use super::job::JobMetadata;
use crate::utils::rclone::endpoints::operations;

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
    pub is_dir: bool,
}

impl GenericTransferParams {
    pub fn to_rclone_body(&self) -> Value {
        let mut body = Map::new();

        if !self.is_dir && matches!(self.transfer_type, TransferType::Copy | TransferType::Move) {
            self.build_file_transfer_body(&mut body);
        } else {
            self.build_directory_transfer_body(&mut body);
        }

        let mut opts = self.options.clone().unwrap_or_default();
        self.process_top_level_options(&mut body, &mut opts);

        if !opts.is_empty() || self.backend_options.is_some() {
            let config = merge_options(Some(opts), self.backend_options.clone());
            if !config.is_empty() {
                body.insert(
                    "_config".to_string(),
                    Value::Object(config.into_iter().collect()),
                );
            }
        }

        if let Some(filters) = self.filter_options.clone() {
            body.insert(
                "_filter".to_string(),
                Value::Object(unwrap_nested_options(filters).into_iter().collect()),
            );
        }

        Value::Object(body)
    }

    fn build_file_transfer_body(&self, body: &mut Map<String, Value>) {
        let endpoint = if self.transfer_type == TransferType::Copy {
            operations::COPYFILE
        } else {
            operations::MOVEFILE
        };
        let src_parsed = parse_fs(&self.source);
        let dst_parsed = parse_fs(&self.dest);

        if let (Some(src), Some(dst)) = (src_parsed, dst_parsed) {
            let (src_fs, src_remote) = src.into_base_and_root();
            let (dst_fs, dst_root) = dst.into_base_and_root();

            let filename = src_remote
                .split(['/', '\\'])
                .next_back()
                .unwrap_or(&src_remote);
            let dst_remote = if dst_root.is_empty() {
                filename.to_string()
            } else {
                format!("{}/{}", dst_root.trim_end_matches(['/', '\\']), filename)
            };

            body.insert(
                "srcFs".to_string(),
                fs_value_with_runtime_overrides(&src_fs, self.runtime_remote_options.as_ref()),
            );
            body.insert("srcRemote".to_string(), Value::String(src_remote));
            body.insert(
                "dstFs".to_string(),
                fs_value_with_runtime_overrides(&dst_fs, self.runtime_remote_options.as_ref()),
            );
            body.insert("dstRemote".to_string(), Value::String(dst_remote));
            body.insert("_path".to_string(), Value::String(endpoint.to_string()));
        } else {
            self.build_directory_transfer_body(body);
        }
    }

    fn build_directory_transfer_body(&self, body: &mut Map<String, Value>) {
        let src_fs =
            fs_value_with_runtime_overrides(&self.source, self.runtime_remote_options.as_ref());
        let dst_fs =
            fs_value_with_runtime_overrides(&self.dest, self.runtime_remote_options.as_ref());

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
    }

    fn process_top_level_options(
        &self,
        body: &mut Map<String, Value>,
        opts: &mut HashMap<String, Value>,
    ) {
        const TOP_LEVEL_KEYS: &[&str] = &[
            "createEmptySrcDirs",
            "deleteEmptySrcDirs",
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

        for key in TOP_LEVEL_KEYS {
            if let Some(val) = opts.remove(*key)
                && !val.is_null()
                && (val != Value::Bool(false))
            {
                body.insert((*key).to_string(), val);
            }
        }
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
    transfer_type: TransferType,
    params: ProfileParams,
) -> Result<String, String> {
    let config_key = match transfer_type {
        TransferType::Sync => "syncConfigs",
        TransferType::Copy => "copyConfigs",
        TransferType::Move => "moveConfigs",
        TransferType::Bisync => "bisyncConfigs",
    };

    let (config, settings) = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        config_key,
    )
    .await
    .map_err(|e| format!("Profile error: {e}"))?;

    let common = parse_common_config(&config, &settings, &params.remote_name).ok_or_else(|| {
        format!(
            "Profile {} configuration is incomplete",
            params.profile_name
        )
    })?;

    let mut inputs = Vec::new();
    let is_copy_move = matches!(transfer_type, TransferType::Copy | TransferType::Move);

    for source in &common.sources {
        let is_dir = if is_copy_move {
            is_directory(&app, source, common.runtime_remote_options.as_ref())
                .await
                .unwrap_or(true)
        } else {
            true
        };

        for dest in &common.dests {
            inputs.push(
                GenericTransferParams {
                    source: source.clone(),
                    dest: dest.clone(),
                    options: common.options.clone(),
                    filter_options: common.filter_options.clone(),
                    backend_options: common.backend_options.clone(),
                    runtime_remote_options: common.runtime_remote_options.clone(),
                    transfer_type,
                    is_dir,
                }
                .to_rclone_body(),
            );
        }
    }

    if inputs.is_empty() {
        return Err("No valid jobs generated".to_string());
    }

    let job_source = if common.sources.len() > 1 {
        format!("{} (+...)", common.sources[0])
    } else {
        common.sources[0].clone()
    };

    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        JobMetadata {
            remote_name: params.remote_name.clone(),
            job_type: transfer_type.as_job_type(),
            source: job_source,
            destination: common.dests[0].clone(),
            profile: Some(params.profile_name.clone()),
            origin: params.source,
            group: None,
            no_cache: params.no_cache.unwrap_or(false),
        },
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
            is_dir: true,
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
            is_dir: true,
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
            is_dir: true,
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

    #[test]
    fn test_file_copy_body_generation() {
        let params = GenericTransferParams {
            source: "src:file.txt".to_string(),
            dest: "dst:backup/".to_string(),
            options: None,
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: TransferType::Copy,
            is_dir: false,
        };

        let body = params.to_rclone_body();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("srcFs").unwrap(), "src:");
        assert_eq!(obj.get("srcRemote").unwrap(), "file.txt");
        assert_eq!(obj.get("dstFs").unwrap(), "dst:");
        assert_eq!(obj.get("dstRemote").unwrap(), "backup/file.txt");
        assert_eq!(obj.get("_path").unwrap(), operations::COPYFILE);
    }
}
