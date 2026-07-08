use std::collections::HashMap;

use futures::future::join_all;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::utils::{
    rclone::endpoints::{core, operations},
    types::{
        jobs::JobType,
        remotes::{DEST_KEYS, OperationType, ProfileParams, SOURCE_KEYS},
    },
};

use super::common::{fs_value_with_runtime_overrides, is_directory, parse_common_config, parse_fs};
use super::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};

/// Unified parameter structure for all transfer operations
#[derive(Debug, Clone)]
pub struct GenericTransferParams {
    pub source: String,
    pub dest: String,
    pub rclone_config: Value,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub transfer_type: OperationType,
    pub is_dir: bool,
}

impl GenericTransferParams {
    pub fn to_rclone_body(&self) -> Result<Value, String> {
        let mut body = match self.rclone_config.clone() {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };

        if self.transfer_type == OperationType::Delete {
            let endpoint = if self.is_dir {
                operations::PURGE
            } else {
                operations::DELETEFILE
            };
            let parsed = parse_fs(&self.source);
            if let Some((fs, mut remote)) = parsed {
                if fs.ends_with(':') {
                    remote = remote.trim_start_matches('/').to_string();
                }
                body.insert(
                    "fs".to_string(),
                    fs_value_with_runtime_overrides(&fs, self.runtime_remote_options.as_ref()),
                );
                body.insert("remote".to_string(), Value::String(remote));
                body.insert("_path".to_string(), Value::String(endpoint.to_string()));
            } else {
                return Err(format!("Could not parse source path: {}", self.source));
            }
        } else if self.transfer_type == OperationType::Copyurl {
            let parsed = parse_fs(&self.dest);
            if let Some((fs, mut remote)) = parsed {
                if fs.ends_with(':') {
                    remote = remote.trim_start_matches('/').to_string();
                }
                let auto_filename = self
                    .rclone_config
                    .get("autoFilename")
                    .or_else(|| self.rclone_config.get("auto_filename"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                body.insert("url".to_string(), Value::String(self.source.clone()));
                body.insert(
                    "fs".to_string(),
                    fs_value_with_runtime_overrides(&fs, self.runtime_remote_options.as_ref()),
                );
                body.insert("remote".to_string(), Value::String(remote));
                body.insert("autoFilename".to_string(), Value::Bool(auto_filename));
                body.insert(
                    "_path".to_string(),
                    Value::String(operations::COPYURL.to_string()),
                );
            } else {
                return Err(format!("Could not parse destination path: {}", self.dest));
            }
        } else if !self.is_dir
            && matches!(
                self.transfer_type,
                OperationType::Copy | OperationType::Move
            )
        {
            self.build_file_transfer_body(&mut body)?;
        } else {
            self.build_directory_transfer_body(&mut body);
        }

        // Merge resolved filter_options into _filter
        if let Some(filters) = &self.filter_options {
            let mut filter_map = body
                .get("_filter")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            for (k, v) in filters {
                filter_map.entry(k.clone()).or_insert_with(|| v.clone());
            }
            body.insert("_filter".to_string(), Value::Object(filter_map));
        }

        // Merge resolved backend_options into _config
        let mut final_backend = match &self.backend_options {
            Some(opts) => crate::rclone::commands::common::filter_empty_options(opts),
            None => std::collections::HashMap::new(),
        };

        if let Some(existing_config) = body.get("_config").and_then(|v| v.as_object()) {
            for (k, v) in existing_config {
                final_backend.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        if !final_backend.is_empty() {
            body.insert(
                "_config".to_string(),
                serde_json::to_value(final_backend).unwrap(),
            );
        }

        Ok(Value::Object(body))
    }

    fn build_file_transfer_body(&self, body: &mut Map<String, Value>) -> Result<(), String> {
        let endpoint = if self.transfer_type == OperationType::Copy {
            operations::COPYFILE
        } else {
            operations::MOVEFILE
        };
        let src_parsed = parse_fs(&self.source);
        let dst_parsed = parse_fs(&self.dest);

        if let (Some((src_fs, mut src_remote)), Some((dst_fs, mut dst_root))) =
            (src_parsed, dst_parsed)
        {
            if src_fs.ends_with(':') {
                src_remote = src_remote.trim_start_matches('/').to_string();
            }
            if dst_fs.ends_with(':') {
                dst_root = dst_root.trim_start_matches('/').to_string();
            }
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
            Ok(())
        } else {
            Err(format!(
                "Could not parse source '{}' or destination '{}' as a file path. Ensure the format is 'remote:path/to/file' or a local path.",
                self.source, self.dest
            ))
        }
    }

    fn build_directory_transfer_body(&self, body: &mut Map<String, Value>) {
        let src_fs =
            fs_value_with_runtime_overrides(&self.source, self.runtime_remote_options.as_ref());
        let dst_fs =
            fs_value_with_runtime_overrides(&self.dest, self.runtime_remote_options.as_ref());

        if self.transfer_type == OperationType::Bisync {
            body.insert("path1".to_string(), src_fs);
            body.insert("path2".to_string(), dst_fs);
        } else {
            body.insert("srcFs".to_string(), src_fs);
            body.insert("dstFs".to_string(), dst_fs);
        }
        body.insert(
            "_path".to_string(),
            Value::String(self.transfer_type.endpoint().unwrap_or("").to_string()),
        );
    }
}

fn has_archive_extension(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".zip")
        || lower.ends_with(".tar")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
        || lower.ends_with(".tar.bz2")
        || lower.ends_with(".tbz")
        || lower.ends_with(".tar.xz")
        || lower.ends_with(".txz")
        || lower.ends_with(".tar.zst")
        || lower.ends_with(".tar.br")
        || lower.ends_with(".tar.sz")
        || lower.ends_with(".tar.mz")
        || lower.ends_with(".tar.lz")
        || lower.ends_with(".tar.lz4")
}

fn to_kebab_case(s: &str) -> String {
    let mut kebab = String::new();
    for (i, c) in s.chars().enumerate() {
        if c == '_' {
            kebab.push('-');
        } else if c.is_uppercase() {
            if i > 0 && !kebab.ends_with('-') {
                kebab.push('-');
            }
            kebab.push(c.to_ascii_lowercase());
        } else {
            kebab.push(c);
        }
    }
    kebab
}

#[tauri::command]
pub async fn start_profile_batch(
    app: AppHandle,
    transfer_type: OperationType,
    params: ProfileParams,
) -> Result<String, String> {
    let config_key = transfer_type.config_key();

    let (config, settings) = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        config_key,
    )
    .await
    .map_err(|e| format!("Profile error: {e}"))?;

    let common = parse_common_config(&config, &settings).ok_or_else(|| {
        format!(
            "Profile {} configuration is incomplete",
            params.profile_name
        )
    })?;

    if (transfer_type == OperationType::Bisync || transfer_type == OperationType::Archivecreate)
        && common.source.len() != 1
    {
        return Err(format!(
            "{transfer_type:?} only supports a single source path"
        ));
    }

    let mut inputs = Vec::new();

    let dest = common.dest.clone();
    if dest.is_empty() && transfer_type != OperationType::Delete {
        return Err("No destination specified".to_string());
    }

    let mut tasks = Vec::new();
    for source in &common.source {
        let app = app.clone();
        let source = source.clone();
        let runtime_remote_options = common.runtime_remote_options.clone();
        tasks.push(async move {
            let is_dir = is_directory(&app, &source, runtime_remote_options.as_ref())
                .await
                .unwrap_or(true);
            (source, is_dir)
        });
    }

    let results = join_all(tasks).await;

    // Validate that Sync, Bisync, and Check do not contain files
    if matches!(
        transfer_type,
        OperationType::Sync | OperationType::Bisync | OperationType::Check
    ) {
        for (source, is_dir) in &results {
            if !*is_dir {
                return Err(format!(
                    "{transfer_type:?} only supports directories, not files: {source}"
                ));
            }
        }
    }

    // Detect if DryRun was set in the resolved options
    let dry_run = if transfer_type == OperationType::Bisync {
        common
            .rclone_config
            .get("dryRun")
            .or_else(|| common.rclone_config.get("DryRun"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    } else {
        common
            .backend_options
            .as_ref()
            .and_then(|opts| opts.get("DryRun"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    };

    let filenames = common
        .rclone_config
        .get("filenames")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<String>>()
        });

    let mut first_job_id = None;

    for (i, (source, is_dir)) in results.into_iter().enumerate() {
        if transfer_type == OperationType::Archivecreate
            || transfer_type == OperationType::Cryptcheck
        {
            let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
            let backend = backend_manager.get_active().await;
            let os = backend_manager.get_runtime_os(&backend.name).await;

            let cmd_name = if transfer_type == OperationType::Archivecreate {
                "archive"
            } else {
                "cryptcheck"
            };
            let mut dest_val = dest.clone();
            if transfer_type == OperationType::Archivecreate && !has_archive_extension(&dest_val) {
                let format = if let Value::Object(map) = &common.rclone_config {
                    map.get("format").and_then(|v| v.as_str()).unwrap_or("zip")
                } else {
                    "zip"
                };
                let clean_src = source.trim_end_matches(':');
                let folder_name = clean_src
                    .split(['/', '\\'])
                    .rfind(|s| !s.is_empty())
                    .unwrap_or("archive");

                let filename = format!("{}.{}", folder_name, format);
                if dest_val.ends_with(':') || dest_val.ends_with('/') || dest_val.ends_with('\\') {
                    dest_val.push_str(&filename);
                } else {
                    dest_val.push_str(&format!("/{filename}"));
                }
            }

            let mut args = if transfer_type == OperationType::Archivecreate {
                vec!["create".to_string(), source.clone(), dest_val.clone()]
            } else {
                vec![source.clone(), dest_val.clone()]
            };

            if let Value::Object(map) = &common.rclone_config {
                for (key, val) in map {
                    if SOURCE_KEYS.contains(&key.as_str()) || DEST_KEYS.contains(&key.as_str()) {
                        continue;
                    }
                    let flag_name = format!("--{}", to_kebab_case(key));
                    match val {
                        Value::Bool(b) => {
                            if *b {
                                args.push(flag_name);
                            }
                        }
                        Value::String(s) => {
                            if !s.is_empty() {
                                args.push(flag_name);
                                args.push(s.clone());
                            }
                        }
                        Value::Number(n) => {
                            args.push(flag_name);
                            args.push(n.to_string());
                        }
                        Value::Array(arr) => {
                            for item in arr {
                                if let Some(s) = item.as_str() {
                                    args.push(flag_name.clone());
                                    args.push(s.to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }

            // Note: async_job = true, because we are calling core/command directly, which supports _async: true
            let payload = backend.build_core_command_payload(cmd_name, args, true, os);

            let metadata = JobMetadata {
                remote_name: params.remote_name.clone(),
                job_type: transfer_type.as_job_type().unwrap_or(JobType::Sync),
                source: vec![source.clone()],
                destination: dest_val.clone(),
                profile: Some(params.profile_name.clone()),
                origin: params.source.clone(),
                group: None,
                no_cache: params.no_cache.unwrap_or(false),
                dry_run,
                parent_job_id: None,
            };

            let (jobid, _, _) = submit_job_with_options(
                app.clone(),
                core::COMMAND,
                payload,
                metadata,
                SubmitJobOptions {
                    wait_for_completion: false,
                },
            )
            .await?;

            if first_job_id.is_none() {
                first_job_id = Some(jobid);
            }
        } else {
            let mut custom_dest = dest.clone();
            let mut custom_config = common.rclone_config.clone();

            if transfer_type == OperationType::Copyurl
                && let Some(ref names) = filenames
                && let Some(filename) = names.get(i)
            {
                if !filename.is_empty() {
                    let clean_dest = custom_dest.trim_end_matches(['/', '\\']);
                    custom_dest = format!("{}/{}", clean_dest, filename);
                    if let Value::Object(ref mut map) = custom_config {
                        map.insert("autoFilename".to_string(), Value::Bool(false));
                    }
                } else if let Value::Object(ref mut map) = custom_config {
                    map.insert("autoFilename".to_string(), Value::Bool(true));
                }
            }

            let body = GenericTransferParams {
                source,
                dest: custom_dest,
                rclone_config: custom_config,
                filter_options: common.filter_options.clone(),
                backend_options: common.backend_options.clone(),
                runtime_remote_options: common.runtime_remote_options.clone(),
                transfer_type,
                is_dir,
            }
            .to_rclone_body()
            .map_err(|e| format!("Body generation error: {e}"))?;

            inputs.push(body);
        }
    }

    if !inputs.is_empty() {
        crate::rclone::commands::job::submit_batch_job(
            app,
            inputs,
            JobMetadata {
                remote_name: params.remote_name.clone(),
                job_type: transfer_type.as_job_type().unwrap_or(JobType::Sync),
                source: common.source.clone(),
                destination: common.dest.clone(),
                profile: Some(params.profile_name.clone()),
                origin: params.source,
                group: None,
                no_cache: params.no_cache.unwrap_or(false),
                dry_run,
                parent_job_id: None,
            },
        )
        .await
    } else {
        Ok(first_job_id.unwrap_or(0).to_string())
    }
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
            rclone_config: json!({
                "dryRun": true,
                "_config": {
                    "transfers": 4
                }
            }),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Sync,
            is_dir: true,
        };

        let body = params.to_rclone_body().unwrap();
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
            rclone_config: json!({
                "resync": true
            }),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Bisync,
            is_dir: true,
        };

        let body = params.to_rclone_body().unwrap();
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
            rclone_config: json!({}),
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
            transfer_type: OperationType::Sync,
            is_dir: true,
        };

        let body = params.to_rclone_body().unwrap();
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
            rclone_config: json!({}),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Copy,
            is_dir: false,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("srcFs").unwrap(), "src:");
        assert_eq!(obj.get("srcRemote").unwrap(), "file.txt");
        assert_eq!(obj.get("dstFs").unwrap(), "dst:");
        assert_eq!(obj.get("dstRemote").unwrap(), "backup/file.txt");
        assert_eq!(obj.get("_path").unwrap(), operations::COPYFILE);
    }

    #[test]
    fn test_file_copy_body_generation_failure() {
        let params = GenericTransferParams {
            source: "::invalid".to_string(),
            dest: "dst:".to_string(),
            rclone_config: json!({}),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Copy,
            is_dir: false,
        };

        let result = params.to_rclone_body();
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains(
                "Could not parse source '::invalid' or destination 'dst:' as a file path"
            )
        );
    }

    #[test]
    fn test_file_move_body_generation() {
        let params = GenericTransferParams {
            source: "src:file.txt".to_string(),
            dest: "dst:backup/".to_string(),
            rclone_config: json!({}),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Move,
            is_dir: false,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("srcFs").unwrap(), "src:");
        assert_eq!(obj.get("srcRemote").unwrap(), "file.txt");
        assert_eq!(obj.get("dstFs").unwrap(), "dst:");
        assert_eq!(obj.get("dstRemote").unwrap(), "backup/file.txt");
        assert_eq!(obj.get("_path").unwrap(), operations::MOVEFILE);
    }

    #[test]
    fn test_body_generation_with_filters_and_backend_config_merge() {
        let params = GenericTransferParams {
            source: "src:".to_string(),
            dest: "dst:".to_string(),
            rclone_config: json!({
                "_filter": {
                    "include": "*.jpg"
                },
                "_config": {
                    "transfers": 8
                }
            }),
            filter_options: Some(HashMap::from([("exclude".to_string(), json!("*.png"))])),
            backend_options: Some(HashMap::from([("checkers".to_string(), json!(16))])),
            runtime_remote_options: None,
            transfer_type: OperationType::Sync,
            is_dir: true,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        let filter = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter.get("include").unwrap(), "*.jpg");
        assert_eq!(filter.get("exclude").unwrap(), "*.png");

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("transfers").unwrap(), 8);
        assert_eq!(config.get("checkers").unwrap(), 16);
    }

    #[test]
    fn test_delete_body_generation() {
        let params = GenericTransferParams {
            source: "src:/folder/to/delete".to_string(),
            dest: "".to_string(),
            rclone_config: json!({}),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Delete,
            is_dir: true,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("fs").unwrap(), "src:");
        assert_eq!(obj.get("remote").unwrap(), "folder/to/delete");
        assert_eq!(obj.get("_path").unwrap(), operations::PURGE);
    }

    #[test]
    fn test_copyurl_body_generation() {
        let params = GenericTransferParams {
            source: "https://example.com/file.zip".to_string(),
            dest: "dst:Downloads".to_string(),
            rclone_config: json!({
                "autoFilename": true
            }),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Copyurl,
            is_dir: false,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("url").unwrap(), "https://example.com/file.zip");
        assert_eq!(obj.get("fs").unwrap(), "dst:");
        assert_eq!(obj.get("remote").unwrap(), "Downloads");
        assert_eq!(obj.get("autoFilename").unwrap(), true);
        assert_eq!(obj.get("_path").unwrap(), operations::COPYURL);
    }
}
