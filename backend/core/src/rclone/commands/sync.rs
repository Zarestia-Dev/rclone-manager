use std::collections::HashMap;

use crate::context::AppHandle;
use futures::future::join_all;
use serde_json::{Map, Value, json};

use crate::rclone::backend::{BackendManager, routing_transport::RoutingTransport, types::Backend};
use crate::rclone::endpoints::operations;
use crate::utils::types::jobs::JobType;
use crate::utils::types::remotes::OperationType;
use crate::utils::types::remotes::ProfileParams;

use super::common::{ResolvedProfile, is_directory, parse_fs};
use super::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};

/// Helper to extract dry_run boolean from configs across case variants (dryRun, dry_run, DryRun).
/// Respects Bisync specialization (where dry_run is configured on rclone_config rather than backend_options).
#[must_use]
pub fn lookup_dry_run(
    rclone_config: &Value,
    backend_options: Option<&HashMap<String, Value>>,
    transfer_type: OperationType,
) -> bool {
    let lookup_val = |val: &Value| -> Option<bool> {
        val.get("dryRun")
            .or_else(|| val.get("dry_run"))
            .or_else(|| val.get("DryRun"))
            .or_else(|| val.get("_config").and_then(|config| config.get("DryRun")))
            .and_then(Value::as_bool)
    };

    let lookup_map = |map: &HashMap<String, Value>| -> Option<bool> {
        map.get("DryRun")
            .or_else(|| map.get("dry_run"))
            .or_else(|| map.get("dryRun"))
            .and_then(Value::as_bool)
    };

    if transfer_type == OperationType::Bisync {
        lookup_val(rclone_config).unwrap_or(false)
    } else {
        backend_options
            .and_then(lookup_map)
            .or_else(|| lookup_val(rclone_config))
            .unwrap_or(false)
    }
}

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
    pub dry_run: Option<bool>,
}

impl GenericTransferParams {
    /// Resolves the effective dry_run flag. An explicit override on the params
    /// takes precedence; otherwise auto-detects from configs.
    #[must_use]
    pub fn resolve_dry_run(&self) -> bool {
        if let Some(explicit) = self.dry_run {
            return explicit;
        }
        lookup_dry_run(
            &self.rclone_config,
            self.backend_options.as_ref(),
            self.transfer_type,
        )
    }

    pub fn to_rclone_body(&self) -> Result<Value, String> {
        let mut builder = crate::rclone::commands::common::RclonePayloadBuilder::from_rclone_config(
            &self.rclone_config,
        );

        let is_dry_run = self.resolve_dry_run();
        let mut backend_opts = self.backend_options.clone();

        if is_dry_run || self.dry_run.is_some() {
            builder.insert("dry_run", json!(is_dry_run));
            builder.insert("dryRun", json!(is_dry_run));
            if let Some(config) = builder
                .as_map_mut()
                .get_mut("_config")
                .and_then(Value::as_object_mut)
            {
                config.remove("dry_run");
                config.remove("dryRun");
            }
            let map = backend_opts.get_or_insert_with(HashMap::new);
            map.remove("dry_run");
            map.remove("dryRun");
            map.insert("DryRun".to_string(), json!(is_dry_run));
        }

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
                builder.insert("fs", fs);
                builder.insert("remote", remote);
                builder.insert("_path", endpoint);
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

                builder.insert("url", self.source.clone());
                builder.insert("fs", fs);
                builder.insert("remote", remote);
                builder.insert("autoFilename", auto_filename);
                builder.insert("_path", operations::COPYURL);
            } else {
                return Err(format!("Could not parse destination path: {}", self.dest));
            }
        } else if self.transfer_type == OperationType::Archivecreate {
            builder.insert("action", "create");
            builder.insert("src", self.source.clone());
            builder.insert("dst", self.dest.clone());
            if let Some(full_path) = self.rclone_config.get("fullPath") {
                builder.insert("full_path", full_path.clone());
                builder.as_map_mut().remove("fullPath");
            }
            builder.insert("_path", operations::ARCHIVE);
        } else if self.transfer_type == OperationType::Cryptcheck {
            builder.insert("src", self.source.clone());
            builder.insert("dst", self.dest.clone());
            builder.insert("_path", operations::CRYPTCHECK);
        } else if !self.is_dir
            && matches!(
                self.transfer_type,
                OperationType::Copy | OperationType::Move
            )
        {
            self.build_file_transfer_body(builder.as_map_mut())?;
        } else {
            self.build_directory_transfer_body(builder.as_map_mut());
        }

        builder
            .with_filter_options(self.filter_options.as_ref())
            .with_backend_options(backend_opts.as_ref());
        builder.with_runtime_remote_options(self.runtime_remote_options.as_ref())?;
        Ok(builder.build())
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

            body.insert("srcFs".to_string(), Value::String(src_fs));
            body.insert("srcRemote".to_string(), Value::String(src_remote));
            body.insert("dstFs".to_string(), Value::String(dst_fs));
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
        if self.transfer_type == OperationType::Bisync {
            body.insert("path1".to_string(), Value::String(self.source.clone()));
            body.insert("path2".to_string(), Value::String(self.dest.clone()));
        } else {
            body.insert("srcFs".to_string(), Value::String(self.source.clone()));
            body.insert("dstFs".to_string(), Value::String(self.dest.clone()));
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

fn build_archive_final_dest(source: &str, dest: &str, format: &str) -> String {
    if has_archive_extension(dest) {
        return dest.to_string();
    }
    let name = source
        .trim_end_matches(['/', '\\', ':'])
        .split(['/', '\\', ':'])
        .rfind(|part| !part.is_empty())
        .unwrap_or("archive");
    let separator = if dest.ends_with(['/', '\\', ':']) {
        ""
    } else {
        "/"
    };
    format!("{dest}{separator}{name}.{format}")
}

fn invalid_option(key: &str) -> String {
    crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => key)
}

fn scalar_option(key: &str, value: &Value) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Bool(_) | Value::Number(_) => Ok(value.to_string()),
        _ => Err(invalid_option(key)),
    }
}

/// Translate legacy RC field names using the target daemon's schema. Names such
/// as BWLimit and IncludeRule cannot be reliably converted by changing case.
fn command_flags(body: &Value, schema: &Value) -> Result<Vec<String>, String> {
    let mut flags = std::collections::BTreeMap::new();
    let mut collect = |key: &str, value: &Value, block: Option<&str>| -> Result<(), String> {
        let name = if let Some(block) = block {
            schema
                .get(block)
                .and_then(Value::as_array)
                .and_then(|options| {
                    options.iter().find(|option| {
                        option["FieldName"]
                            .as_str()
                            .and_then(|field| field.rsplit('.').next())
                            == Some(key)
                            || option["Name"].as_str() == Some(key)
                    })
                })
                .and_then(|option| option["Name"].as_str())
                .ok_or_else(|| invalid_option(key))?
                .replace('_', "-")
        } else {
            key.replace('_', "-")
        };
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || name.is_empty() {
            return Err(invalid_option(key));
        }
        let values = if let Some(values) = value.as_array() {
            // Omitting an empty list can re-enable filters inherited by the
            // subprocess. The CLI has no equivalent for clearing that list.
            if values.is_empty() {
                return Err(invalid_option(key));
            }
            values
                .iter()
                .map(|value| scalar_option(key, value))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            vec![scalar_option(key, value)?]
        };
        flags.insert(name, values);
        Ok(())
    };
    let body = body.as_object().ok_or_else(|| invalid_option("payload"))?;
    for (key, value) in body {
        if matches!(
            key.as_str(),
            "src" | "dst" | "action" | "_path" | "dryRun" | "_config" | "_filter"
        ) {
            continue;
        }
        collect(key, value, None)?;
    }
    // Nested blocks have the same precedence as in rclone's RC context parser.
    for (key, block) in [("_config", "main"), ("_filter", "filter")] {
        if let Some(options) = body.get(key) {
            for (key, value) in options.as_object().ok_or_else(|| invalid_option(key))? {
                collect(key, value, Some(block))?;
            }
        }
    }
    Ok(flags
        .into_iter()
        .flat_map(|(name, values)| {
            values
                .into_iter()
                .map(move |value| format!("--{name}={value}"))
        })
        .collect())
}

pub(crate) async fn build_special_transfer_payload(
    app: &AppHandle,
    backend: &Backend,
    params: &GenericTransferParams,
) -> Result<(&'static str, Value), String> {
    let (endpoint, command) = match params.transfer_type {
        OperationType::Archivecreate => (operations::ARCHIVE, "archive"),
        OperationType::Cryptcheck => (operations::CRYPTCHECK, "cryptcheck"),
        _ => return Err(invalid_option("operation")),
    };
    let mut body = params.to_rclone_body()?;
    if backend.is_librclone_local() {
        body.as_object_mut().unwrap().remove("_path");
        body.as_object_mut().unwrap().remove("dryRun");
        return Ok((endpoint, body));
    }
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let schema = transport.rpc(crate::rclone::endpoints::options::INFO, Some(&json!({"blocks": "main,filter"})))
        .await.map_err(|error| crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => error.to_string()))?;
    let mut args = Vec::new();
    if params.transfer_type == OperationType::Archivecreate {
        args.push("create".to_string());
    }
    args.push(body["src"].as_str().unwrap().to_string());
    args.push(body["dst"].as_str().unwrap().to_string());
    args.extend(command_flags(&body, &schema)?);
    let os = app
        .state::<BackendManager>()
        .get_runtime_os(&backend.name)
        .await;
    Ok((
        crate::rclone::endpoints::core::COMMAND,
        backend.build_core_command_payload(command, args, true, os),
    ))
}

/// Core runner to execute batch transfers with directory checking, dry-run resolution,
/// payload generation, and batch job submission across Remote Profiles, Quick Runs, and Workflows.
pub async fn submit_transfer_batch(
    app: AppHandle,
    backend: Backend,
    transfer_type: OperationType,
    target_pairs: Vec<(String, String)>,
    common: &crate::rclone::commands::common::CommonConfigParams,
    dry_run: bool,
    metadata: JobMetadata,
) -> Result<String, String> {
    if target_pairs.is_empty()
        || target_pairs
            .iter()
            .any(|(source, _)| source.trim().is_empty())
    {
        return Err(invalid_option("source"));
    }
    if transfer_type != OperationType::Delete
        && target_pairs.iter().any(|(_, dest)| dest.trim().is_empty())
    {
        return Err(invalid_option("destination"));
    }
    if (transfer_type == OperationType::Bisync || transfer_type == OperationType::Archivecreate)
        && target_pairs.len() != 1
    {
        return Err(format!(
            "{transfer_type:?} only supports a single source path"
        ));
    }

    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let mut tasks = Vec::with_capacity(target_pairs.len());
    for (source, _) in &target_pairs {
        let transport = transport.clone();
        let source = source.clone();
        let runtime_remote_options = common.runtime_remote_options.clone();
        tasks.push(async move {
            let is_dir = if transfer_type == OperationType::Copyurl {
                false
            } else {
                is_directory(transport.as_ref(), &source, runtime_remote_options.as_ref()).await?
            };
            Ok::<_, String>((source, is_dir))
        });
    }

    let dir_results = join_all(tasks)
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;

    // Validate that Sync, Bisync, and Check do not contain files
    if matches!(
        transfer_type,
        OperationType::Sync | OperationType::Bisync | OperationType::Check
    ) {
        for (source, is_dir) in &dir_results {
            if !*is_dir {
                return Err(format!(
                    "{transfer_type:?} only supports directories, not files: {source}"
                ));
            }
        }
    }

    let filenames = common
        .rclone_config
        .get("filenames")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<String>>()
        });

    let mut inputs = Vec::new();
    let mut special_jobs = Vec::new();

    for (i, ((source, mut dest), (_, is_dir))) in
        target_pairs.into_iter().zip(dir_results).enumerate()
    {
        let mut config = common.rclone_config.clone();
        if transfer_type == OperationType::Archivecreate {
            let format = config
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or("zip");
            dest = build_archive_final_dest(&source, &dest, format);
        }
        if transfer_type == OperationType::Copyurl
            && let Some(filename) = filenames.as_ref().and_then(|names| names.get(i))
        {
            if !filename.is_empty() {
                dest = format!("{}/{}", dest.trim_end_matches(['/', '\\']), filename);
            }
            if let Some(map) = config.as_object_mut() {
                map.insert("autoFilename".to_string(), json!(filename.is_empty()));
            }
        }

        let params = GenericTransferParams {
            source: source.clone(),
            dest: dest.clone(),
            rclone_config: config,
            filter_options: common.filter_options.clone(),
            backend_options: common.backend_options.clone(),
            runtime_remote_options: common.runtime_remote_options.clone(),
            transfer_type,
            is_dir,
            dry_run: Some(dry_run),
        };
        if matches!(
            transfer_type,
            OperationType::Archivecreate | OperationType::Cryptcheck
        ) {
            let (endpoint, payload) =
                build_special_transfer_payload(&app, &backend, &params).await?;
            let mut job_metadata = metadata.clone();
            job_metadata.source = vec![source];
            job_metadata.destination = dest;
            special_jobs.push((endpoint, payload, job_metadata));
        } else {
            inputs.push(params.to_rclone_body()?);
        }
    }

    // Validate and encode every input before sending the first mutating request.
    let mut last_job_id = None;
    let job_count = special_jobs.len();
    for (index, (endpoint, payload, mut job_metadata)) in special_jobs.into_iter().enumerate() {
        let wait = index + 1 < job_count;
        // Earlier commands finish before the final handle is returned. Only the
        // final job may complete the automation's reserved execution identity.
        if wait {
            job_metadata.execute_id = None;
        }
        let submission = submit_job_with_options(
            app.clone(),
            endpoint,
            payload,
            job_metadata,
            SubmitJobOptions {
                backend: Some(backend.clone()),
                wait_for_completion: wait,
            },
        )
        .await?;
        last_job_id = Some(submission.job_id);
    }
    if !inputs.is_empty() {
        crate::rclone::commands::job::submit_batch_job_with_options(
            app,
            inputs,
            metadata,
            SubmitJobOptions {
                backend: Some(backend),
                ..Default::default()
            },
        )
        .await
    } else {
        Ok(last_job_id.unwrap_or(0).to_string())
    }
}

pub async fn start_profile_batch(
    app: AppHandle,
    transfer_type: OperationType,
    params: ProfileParams,
) -> Result<String, String> {
    let resolved = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        transfer_type,
        params.backend_name.as_deref(),
    )
    .await?;

    start_resolved_profile_batch(app, resolved, transfer_type, params).await
}

pub(crate) async fn start_resolved_profile_batch(
    app: AppHandle,
    resolved: ResolvedProfile,
    transfer_type: OperationType,
    params: ProfileParams,
) -> Result<String, String> {
    let backend = resolved.backend;
    let common = resolved.params;

    let (target_pairs, is_scoped) = if transfer_type != OperationType::Bisync
        && let Some(scoped) = params.scoped_targets.filter(|t| !t.is_empty())
    {
        (scoped, true)
    } else {
        let dest = common.dest.clone();
        if dest.is_empty() && transfer_type != OperationType::Delete {
            return Err("No destination specified".to_string());
        }
        (
            common
                .source
                .iter()
                .map(|s| (s.clone(), dest.clone()))
                .collect(),
            false,
        )
    };

    // Detect if DryRun was set in the resolved options
    let dry_run = lookup_dry_run(
        &common.rclone_config,
        common.backend_options.as_ref(),
        transfer_type,
    );

    let metadata_source = if is_scoped {
        target_pairs.iter().map(|(s, _)| s.clone()).collect()
    } else {
        common.source.clone()
    };
    let metadata_dest = if is_scoped {
        target_pairs
            .first()
            .map(|(_, d)| d.clone())
            .unwrap_or_else(|| common.dest.clone())
    } else {
        common.dest.clone()
    };

    let metadata = JobMetadata::new(
        params.remote_name.clone(),
        transfer_type.as_job_type().unwrap_or(JobType::Sync),
        metadata_source,
        metadata_dest,
    )
    .with_profile(Some(params.profile_name.clone()))
    .with_origin(params.source)
    .with_no_cache(params.no_cache.unwrap_or(false))
    .with_dry_run(dry_run)
    .with_execute_id(params.execute_id);

    submit_transfer_batch(
        app,
        backend,
        transfer_type,
        target_pairs,
        &common,
        dry_run,
        metadata,
    )
    .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn special_params(operation: OperationType, dry_run: bool) -> GenericTransferParams {
        GenericTransferParams {
            source: "source:photos".into(),
            dest: "target:backup/photos.zip".into(),
            rclone_config: json!({"format": "zip", "prefix": "my files", "fullPath": true}),
            filter_options: Some(HashMap::from([
                ("IncludeRule".into(), json!(["*.jpg", "a,b.png"])),
                ("exclude".into(), json!(["*.tmp"])),
            ])),
            backend_options: Some(HashMap::from([
                ("BWLimit".into(), json!("10M")),
                ("Transfers".into(), json!(2)),
                ("DryRun".into(), json!(!dry_run)),
            ])),
            runtime_remote_options: Some(HashMap::from([
                (
                    "source".into(),
                    json!({"env_auth": true, "region": "a'b,c:d"}),
                ),
                ("target".into(), json!({"chunk_size": 1048576})),
            ])),
            transfer_type: operation,
            is_dir: true,
            dry_run: Some(dry_run),
        }
    }

    fn command_schema() -> Value {
        json!({
            "main": [
                {"Name": "dry_run", "FieldName": "DryRun"},
                {"Name": "bwlimit", "FieldName": "BWLimit"},
                {"Name": "transfers", "FieldName": "Transfers"}
            ],
            "filter": [{"Name": "include", "FieldName": "RulesOpt.IncludeRule"}]
        })
    }

    #[test]
    fn special_transfers_preserve_common_options_and_runtime_paths() {
        for operation in [OperationType::Archivecreate, OperationType::Cryptcheck] {
            for dry_run in [true, false] {
                let mut params = special_params(operation, dry_run);
                if operation == OperationType::Cryptcheck {
                    params.rclone_config = json!({"one_way": true});
                }
                let body = params.to_rclone_body().unwrap();
                assert_eq!(body["_config"]["DryRun"], dry_run);
                assert_eq!(body["_config"]["Transfers"], 2);
                assert_eq!(body["_filter"]["IncludeRule"], json!(["*.jpg", "a,b.png"]));
                assert_eq!(
                    body["src"],
                    "source,env_auth='true',region='a''b,c:d':photos"
                );
                assert_eq!(body["dst"], "target,chunk_size='1048576':backup/photos.zip");
                assert!(body.get("source").is_none());
                assert!(body.get("target").is_none());

                let flags = command_flags(&body, &command_schema()).unwrap();
                assert!(flags.contains(&format!("--dry-run={dry_run}")));
                assert!(!flags.contains(&format!("--dry-run={}", !dry_run)));
                for flag in [
                    "--bwlimit=10M",
                    "--transfers=2",
                    "--include=*.jpg",
                    "--include=a,b.png",
                    "--exclude=*.tmp",
                ] {
                    assert!(
                        flags.contains(&flag.to_string()),
                        "missing {flag}: {flags:?}"
                    );
                }
                if operation == OperationType::Archivecreate {
                    assert!(flags.contains(&"--full-path=true".to_string()));
                    assert!(flags.contains(&"--prefix=my files".to_string()));
                } else {
                    assert!(flags.contains(&"--one-way=true".to_string()));
                }
            }
        }
    }

    #[test]
    fn command_encoding_rejects_unknown_or_structured_flags() {
        for body in [
            json!({"_config": {"UnknownSetting": true}}),
            json!({"_filter": {"UnknownFilter": "*.jpg"}}),
            json!({"vfsOpt": {"CacheMode": "full"}}),
            json!({"format": null}),
            json!({"format": [null]}),
            json!({"include": []}),
        ] {
            let error = command_flags(&body, &command_schema()).unwrap_err();
            assert!(error.contains("backendErrors.rclone.invalidFlags"));
        }
    }

    #[test]
    fn command_encoding_applies_nested_precedence() {
        let flags = command_flags(
            &json!({
                "dry_run": false, "include": ["*.png"],
                "_config": {"DryRun": true}, "_filter": {"IncludeRule": ["*.txt"]}
            }),
            &command_schema(),
        )
        .unwrap();
        assert_eq!(flags, vec!["--dry-run=true", "--include=*.txt"]);
    }

    #[test]
    fn explicit_dry_run_cannot_be_overridden_by_legacy_aliases() {
        for dry_run in [true, false] {
            let mut params = special_params(OperationType::Archivecreate, dry_run);
            params.rclone_config =
                json!({"_config": {"dry_run": !dry_run, "dryRun": !dry_run, "DryRun": !dry_run}});
            let body = params.to_rclone_body().unwrap();
            assert_eq!(body["_config"]["DryRun"], dry_run);
            assert!(body["_config"].get("dry_run").is_none());
            assert!(body["_config"].get("dryRun").is_none());
        }
        assert!(lookup_dry_run(
            &json!({"_config": {"DryRun": true}}),
            None,
            OperationType::Archivecreate
        ));
    }

    #[test]
    fn test_build_archive_final_dest() {
        // 1. With existing archive extension, keeps as is
        assert_eq!(
            build_archive_final_dest("/home/user/docs", "remote:backups/myarchive.zip", "zip"),
            "remote:backups/myarchive.zip"
        );
        assert_eq!(
            build_archive_final_dest(
                "/home/user/docs",
                "remote:backups/myarchive.tar.gz",
                "tar.gz"
            ),
            "remote:backups/myarchive.tar.gz"
        );

        // 2. Trailing slash / folder destination, appends folder_name.format
        assert_eq!(
            build_archive_final_dest("/home/user/myfolder", "remote:backups/", "zip"),
            "remote:backups/myfolder.zip"
        );
        assert_eq!(
            build_archive_final_dest("gdrive:photos", "local:/backup", "tar"),
            "local:/backup/photos.tar"
        );

        // 3. Trailing colon
        assert_eq!(
            build_archive_final_dest("/home/user/data", "gdrive:", "zip"),
            "gdrive:data.zip"
        );
    }

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
            dry_run: None,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("srcFs").unwrap(), "src:");
        assert_eq!(obj.get("dstFs").unwrap(), "dst:");
        assert_eq!(obj.get("dryRun").unwrap(), true);
        assert_eq!(obj.get("dry_run").unwrap(), true);

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("transfers").unwrap(), 4);
        assert_eq!(config.get("DryRun").unwrap(), true);
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
            dry_run: None,
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
            runtime_remote_options: Some(HashMap::from([(
                "srcRemote".to_string(),
                json!({"env_auth":true, "provider":"AWS"}),
            )])),
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: None,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(
            obj.get("srcFs").unwrap(),
            "srcRemote,env_auth='true',provider='AWS':bucket/a"
        );
        assert_eq!(obj.get("dstFs").unwrap(), "dstRemote:bucket/b");
        assert!(obj.get("srcRemote").is_none());
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
            dry_run: None,
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
            dry_run: None,
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
            dry_run: None,
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
                    "IncludeRule": "*.jpg"
                },
                "_config": {
                    "Transfers": 8
                }
            }),
            filter_options: Some(HashMap::from([
                ("exclude".to_string(), json!("*.png")),
                ("ExcludeRule".to_string(), json!(["*.bak"])),
            ])),
            backend_options: Some(HashMap::from([
                ("checkers".to_string(), json!(16)),
                ("Checkers".to_string(), json!(32)),
            ])),
            runtime_remote_options: None,
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: None,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        // Flat lowercase keys placed directly at root level
        assert_eq!(obj.get("exclude").unwrap(), "*.png");
        assert_eq!(obj.get("checkers").unwrap(), 16);

        // PascalCase nested options placed into their respective blocks
        let filter = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter.get("IncludeRule").unwrap(), "*.jpg");
        assert_eq!(filter.get("ExcludeRule").unwrap(), &json!(["*.bak"]));

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("Transfers").unwrap(), 8);
        assert_eq!(config.get("Checkers").unwrap(), 32);
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
            dry_run: None,
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
            dry_run: None,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("url").unwrap(), "https://example.com/file.zip");
        assert_eq!(obj.get("fs").unwrap(), "dst:");
        assert_eq!(obj.get("remote").unwrap(), "Downloads");
        assert_eq!(obj.get("autoFilename").unwrap(), true);
        assert_eq!(obj.get("_path").unwrap(), operations::COPYURL);
    }

    #[test]
    fn test_resolve_dry_run_explicit_and_auto_detect() {
        // Explicit true override
        let explicit_true = GenericTransferParams {
            source: "src:".to_string(),
            dest: "dst:".to_string(),
            rclone_config: json!({}),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: Some(true),
        };
        assert!(explicit_true.resolve_dry_run());

        // Explicit false override takes precedence over config
        let explicit_false = GenericTransferParams {
            source: "src:".to_string(),
            dest: "dst:".to_string(),
            rclone_config: json!({ "dryRun": true }),
            filter_options: None,
            backend_options: Some(HashMap::from([("DryRun".to_string(), json!(true))])),
            runtime_remote_options: None,
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: Some(false),
        };
        assert!(!explicit_false.resolve_dry_run());

        // Auto-detect for Bisync from rclone_config
        let bisync_detected = GenericTransferParams {
            source: "p1".to_string(),
            dest: "p2".to_string(),
            rclone_config: json!({ "dry_run": true }),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Bisync,
            is_dir: true,
            dry_run: None,
        };
        assert!(bisync_detected.resolve_dry_run());

        // Auto-detect for Sync from backend_options
        let sync_detected = GenericTransferParams {
            source: "src:".to_string(),
            dest: "dst:".to_string(),
            rclone_config: json!({}),
            filter_options: None,
            backend_options: Some(HashMap::from([("DryRun".to_string(), json!(true))])),
            runtime_remote_options: None,
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: None,
        };
        assert!(sync_detected.resolve_dry_run());
    }

    #[test]
    fn test_dry_run_payload_injection_for_bisync() {
        let params = GenericTransferParams {
            source: "remote:p1".to_string(),
            dest: "local:/p2".to_string(),
            rclone_config: json!({ "resync": true }),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Bisync,
            is_dir: true,
            dry_run: Some(true),
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("path1").unwrap(), "remote:p1");
        assert_eq!(obj.get("path2").unwrap(), "local:/p2");
        assert_eq!(obj.get("dryRun").unwrap(), true);
        assert_eq!(obj.get("dry_run").unwrap(), true);
        assert_eq!(obj.get("resync").unwrap(), true);
        assert_eq!(
            obj.get("_config")
                .and_then(|c| c.get("DryRun"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }
}
