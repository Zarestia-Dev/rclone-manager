use std::collections::HashMap;

use log::debug;

use crate::context::AppHandle;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::rclone::commands::common::RclonePayloadBuilder;
use crate::rclone::commands::job::{
    JobMetadata, SubmitJobOptions, run_job, submit_job_with_options,
};
use crate::rclone::commands::sync::lookup_dry_run;
use crate::rclone::endpoints::operations;
use crate::rclone::endpoints::sync;
use crate::utils::json_helpers::build_full_path;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::OperationType;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsItem {
    pub remote: String,
    pub path: String,
    /// The name it gets at the destination: its own, or another one that keeps both.
    #[serde(default)]
    pub name: String,
    pub is_dir: bool,
    /// For a folder merged into one of the same name: what happens to the files of the same
    /// name there.
    #[serde(default)]
    pub existing_files: ExistingFiles,
}

/// What a folder merged into one of the same name does with the files of the same name there.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExistingFiles {
    /// The incoming file replaces the one there, as rclone does by default.
    #[default]
    Replace,
    /// The file there stays (`--ignore-existing`).
    Keep,
    /// The newer of the two stays (`--update`).
    Newer,
}

impl ExistingFiles {
    /// The rclone option that keeps the files there, if any.
    fn flag(self) -> Option<&'static str> {
        match self {
            Self::Replace => None,
            Self::Keep => Some("ignore_existing"),
            Self::Newer => Some("update"),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameItem {
    pub remote: String,
    pub src_path: String,
    pub dst_path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Copy,
    Move,
}

pub async fn mkdir(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<Origin>,
    group: Option<String>,
    backend_name: Option<String>,
) -> Result<(), String> {
    debug!("mkdir: remote={remote} path={path}");
    let backend = app
        .state::<crate::rclone::backend::BackendManager>()
        .get_active_checked(backend_name.as_deref())
        .await?;
    let payload = json!({ "fs": &remote, "remote": &path });
    let metadata = JobMetadata::for_mutation(remote, vec![path], "", JobType::Mkdir, origin, group);
    run_job(app, operations::MKDIR, payload, metadata, Some(backend))
        .await
        .map(|_| ())
}

pub async fn cleanup(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let path = path.unwrap_or_default();
    debug!("cleanup: remote={remote} path={path}");
    let mut payload = json!({ "fs": &remote });
    if !path.is_empty() {
        payload["remote"] = json!(&path);
    }
    let metadata =
        JobMetadata::for_mutation(remote, vec![path], "", JobType::Cleanup, origin, group);
    run_job(app, operations::CLEANUP, payload, metadata, None)
        .await
        .map(|_| ())
}

pub async fn copy_url(
    app: AppHandle,
    remote: String,
    path: String,
    url_to_copy: String,
    auto_filename: bool,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    debug!("copy_url: remote={remote} path={path} url={url_to_copy}");
    let payload = json!({
        "fs": &remote,
        "remote": &path,
        "url": &url_to_copy,
        "autoFilename": auto_filename,
    });
    let metadata = JobMetadata::for_mutation(
        remote,
        vec![url_to_copy],
        path,
        JobType::CopyUrl,
        origin,
        group,
    );
    run_job(app, operations::COPYURL, payload, metadata, None)
        .await
        .map(|_| ())
}

pub async fn remove_empty_dirs(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    debug!("remove_empty_dirs: remote={remote} path={path}");
    let payload = json!({ "fs": &remote, "remote": &path, "leaveRoot": true });
    let metadata =
        JobMetadata::for_mutation(remote, vec![path], "", JobType::Rmdirs, origin, group);
    run_job(app, operations::RMDIRS, payload, metadata, None)
        .await
        .map(|_| ())
}

/// Refuses to copy or move a folder into itself or into a folder inside it. rclone copies
/// such a folder without end: each pass lists the folder it has just made and copies it again.
pub(crate) fn refuse_transfer_into_itself(
    items: &[FsItem],
    dst_remote: &str,
    dst_path: &str,
) -> Result<(), String> {
    let destination = build_full_path(dst_remote, dst_path);
    let destination = destination.trim_end_matches('/');
    for item in items.iter().filter(|item| item.is_dir) {
        let source = build_full_path(&item.remote, &item.path);
        let source = source.trim_end_matches('/');
        let inside = destination
            .strip_prefix(source)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'));
        if inside {
            let name = if item.name.is_empty() {
                source
            } else {
                &item.name
            };
            return Err(crate::localized_error!(
                "backendErrors.file.intoItself",
                "name" => name
            ));
        }
    }
    Ok(())
}

/// The `job/batch` inputs that copy or move `items` into `dst_path` on `dst_remote`:
/// `copyfile`/`movefile` for a file, `sync/copy`/`sync/move` for a folder.
///
/// A file is named from its folder on both sides: rclone lists a transfer under the source's
/// name and the destination's root, so a root above the folder would point the job's rows at a
/// file that is not there.
///
/// A copied folder is created first: `sync/copy` creates nothing for a folder without
/// entries, so an empty folder would not arrive (`sync/move` creates it). An item that keeps
/// what exists runs with `ignore_existing`, on top of the batch's own options.
pub(crate) fn transfer_inputs(
    items: &[FsItem],
    dst_remote: &str,
    dst_path: &str,
    mode: TransferMode,
) -> Vec<serde_json::Value> {
    let mut inputs = Vec::new();
    for item in items {
        let dst_file = if dst_path.is_empty() {
            item.name.clone()
        } else {
            format!("{}/{}", dst_path.trim_end_matches('/'), item.name)
        };

        let src_full = build_full_path(&item.remote, &item.path);
        let dst_full = build_full_path(dst_remote, &dst_file);
        let transfers_from = inputs.len();
        let (src_dir, src_name) = item
            .path
            .trim_matches('/')
            .rsplit_once('/')
            .unwrap_or(("", item.path.trim_matches('/')));
        let file_input = |endpoint: &str| {
            json!({
                "_path": endpoint,
                "srcFs": build_full_path(&item.remote, src_dir),
                "srcRemote": src_name,
                "dstFs": build_full_path(dst_remote, dst_path.trim_end_matches('/')),
                "dstRemote": &item.name,
            })
        };

        match (mode, item.is_dir) {
            (TransferMode::Copy, true) => {
                inputs.push(json!({
                    "_path": operations::MKDIR,
                    "fs": dst_remote,
                    "remote": &dst_file,
                }));
                inputs.push(json!({
                    "_path": sync::COPY,
                    "srcFs": src_full,
                    "dstFs": dst_full,
                    "createEmptySrcDirs": true,
                }));
            }
            (TransferMode::Copy, false) => inputs.push(file_input(operations::COPYFILE)),
            (TransferMode::Move, true) => inputs.push(json!({
                "_path": sync::MOVE,
                "srcFs": src_full,
                "dstFs": dst_full,
                "createEmptySrcDirs": true,
                "deleteEmptySrcDirs": true,
            })),
            (TransferMode::Move, false) => inputs.push(file_input(operations::MOVEFILE)),
        }
        if let Some(flag) = item.existing_files.flag() {
            for input in &mut inputs[transfers_from..] {
                if input["_path"] != operations::MKDIR {
                    input[flag] = json!(true);
                }
            }
        }
    }
    inputs
}

/// The options of a file browser copy, move or upload: `options` as rclone takes them in a
/// request (flat names, `_config` and `_filter`) and `remotes` the options of single remotes,
/// keyed by remote name.
#[derive(Debug, Default)]
pub(crate) struct TransferOptions {
    pub options: serde_json::Map<String, Value>,
    pub remotes: HashMap<String, Value>,
}

impl TransferOptions {
    /// The names of the options, shown on the job; a remote's as `drive: chunk_size`.
    pub fn summary(&self) -> Option<String> {
        let mut names = Vec::new();
        for (key, value) in &self.options {
            match (key.as_str(), value.as_object()) {
                ("_config" | "_filter", Some(block)) => names.extend(block.keys().cloned()),
                _ => names.push(key.clone()),
            }
        }
        for (remote, options) in &self.remotes {
            if let Some(options) = options.as_object() {
                names.extend(options.keys().map(|key| format!("{remote}: {key}")));
            }
        }
        names.sort();
        (!names.is_empty()).then(|| names.join(", "))
    }

    /// `request` with each path that names a remote (`fs`, `srcFs`, `dstFs`…) given that
    /// remote's options, as a connection string.
    pub fn apply_remotes(
        &self,
        request: serde_json::Map<String, Value>,
    ) -> Result<serde_json::Map<String, Value>, String> {
        if self.remotes.is_empty() {
            return Ok(request);
        }
        let mut builder = RclonePayloadBuilder::new();
        *builder.as_map_mut() = request;
        builder.with_runtime_remote_options(Some(&self.remotes))?;
        Ok(std::mem::take(builder.as_map_mut()))
    }
}

/// The options a file browser transfer runs with: `values` as the user set them for this
/// transfer, or without them the file browser's default (`nautilus.transfer_options`), which
/// Send To uses too.
pub(crate) fn transfer_options(
    app: &AppHandle,
    values: Option<Value>,
    mode: TransferMode,
) -> TransferOptions {
    let values = values.unwrap_or_else(|| {
        app.state::<crate::services::settings::AppSettingsManager>()
            .get::<Value>("nautilus.transfer_options")
            .unwrap_or_default()
    });
    TransferOptions::from_values(&values, mode)
}

impl TransferOptions {
    /// Reads `copy` or `move`, `filter`, `backend` and `remotes`, each a map of options, and
    /// merges the first three the way a profile's are.
    fn from_values(values: &Value, mode: TransferMode) -> Self {
        let block = |category: &str| -> Option<HashMap<String, Value>> {
            values
                .get(category)
                .and_then(Value::as_object)
                .map(|options| {
                    options
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect()
                })
        };
        let operation = match mode {
            TransferMode::Copy => "copy",
            TransferMode::Move => "move",
        };
        let mut builder =
            RclonePayloadBuilder::from_rclone_config(values.get(operation).unwrap_or(&Value::Null));
        builder
            .with_filter_options(block("filter").as_ref())
            .with_backend_options(block("backend").as_ref());
        Self {
            options: std::mem::take(builder.as_map_mut()),
            remotes: block("remotes").unwrap_or_default(),
        }
    }
}

/// The remote a file browser job names: the one all its items are on, or `multiple`.
fn items_remote<'a>(mut remotes: impl Iterator<Item = &'a str>) -> Result<String, String> {
    let first = remotes
        .next()
        .ok_or_else(|| crate::localized_error!("backendErrors.file.noItems"))?;
    Ok(if remotes.all(|remote| remote == first) {
        first.to_owned()
    } else {
        "multiple".to_owned()
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer(
    app: AppHandle,
    items: Vec<FsItem>,
    dst_remote: String,
    dst_path: String,
    mode: TransferMode,
    origin: Option<Origin>,
    group: Option<String>,
    parent_job_id: Option<u64>,
    options: Option<Value>,
) -> Result<u64, String> {
    let dst_path = if dst_path == "/" {
        String::new()
    } else {
        dst_path
    };

    debug!(
        "transfer: {} items to {dst_remote}:{dst_path} (mode={mode:?})",
        items.len()
    );

    refuse_transfer_into_itself(&items, &dst_remote, &dst_path)?;
    let inputs = transfer_inputs(&items, &dst_remote, &dst_path, mode);

    let job_type = if mode == TransferMode::Move {
        JobType::Move
    } else {
        JobType::Copy
    };

    let remote_name = items_remote(items.iter().map(|item| item.remote.as_str()))?;
    let source = items
        .iter()
        .map(|item| build_full_path(&item.remote, &item.path))
        .collect::<Vec<String>>();

    let metadata = JobMetadata::new(
        remote_name,
        job_type,
        source,
        build_full_path(&dst_remote, &dst_path),
    )
    .with_origin(origin)
    .with_group(group)
    .with_parent_job_id(parent_job_id);

    let options = transfer_options(&app, options, mode);
    submit_transfer_job(app, inputs, options, metadata, Default::default()).await
}

/// Submits the `job/batch` of a file browser copy, move or upload with its options. They
/// sit on the batch, whose settings every input inherits, so its `transfers` also sets how
/// many inputs run at once; the options of single remotes go on the inputs that name them.
pub(crate) async fn submit_transfer_job(
    app: AppHandle,
    inputs: Vec<serde_json::Value>,
    options: TransferOptions,
    metadata: JobMetadata,
    submit: SubmitJobOptions,
) -> Result<u64, String> {
    let inputs = inputs
        .into_iter()
        .map(|input| match input {
            Value::Object(request) => options.apply_remotes(request).map(Value::Object),
            other => Ok(other),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let summary = options.summary();
    let mut payload = options.options;
    let dry_run = lookup_dry_run(&Value::Object(payload.clone()), None, OperationType::Copy);
    payload.insert("inputs".into(), json!(inputs));
    submit_job_with_options(
        app,
        crate::rclone::endpoints::job::BATCH,
        serde_json::Value::Object(payload),
        metadata
            .with_transfer_options(summary)
            .with_dry_run(dry_run),
        submit,
    )
    .await
    .map(|submission| submission.job_id)
}

pub async fn delete(
    app: AppHandle,
    items: Vec<FsItem>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<u64, String> {
    debug!("delete: {} items", items.len());

    let mut inputs = Vec::new();
    for item in &items {
        let endpoint = if item.is_dir {
            operations::PURGE
        } else {
            operations::DELETEFILE
        };
        inputs.push(json!({ "_path": endpoint, "fs": item.remote, "remote": item.path }));
    }

    let remote_name = items_remote(items.iter().map(|item| item.remote.as_str()))?;
    let source = items
        .iter()
        .map(|item| build_full_path(&item.remote, &item.path))
        .collect::<Vec<String>>();

    let metadata = JobMetadata::new(remote_name, JobType::Delete, source, "trash")
        .with_origin(origin)
        .with_group(group);

    crate::rclone::commands::job::submit_batch_job_with_options(
        app,
        inputs,
        metadata,
        Default::default(),
    )
    .await
}

pub async fn rename(
    app: AppHandle,
    items: Vec<RenameItem>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<u64, String> {
    debug!("rename: {} items", items.len());

    let mut inputs = Vec::new();
    for item in &items {
        let src_full = build_full_path(&item.remote, &item.src_path);
        let dst_full = build_full_path(&item.remote, &item.dst_path);

        if item.is_dir {
            inputs.push(json!({
                "_path": sync::MOVE,
                "srcFs": src_full,
                "dstFs": dst_full,
                "createEmptySrcDirs": true,
                "deleteEmptySrcDirs": true,
            }));
        } else {
            inputs.push(json!({
                "_path": operations::MOVEFILE,
                "srcFs": item.remote,
                "srcRemote": item.src_path,
                "dstFs": item.remote,
                "dstRemote": item.dst_path,
            }));
        }
    }

    let remote_name = items_remote(items.iter().map(|item| item.remote.as_str()))?;
    let source = items
        .iter()
        .map(|item| build_full_path(&item.remote, &item.src_path))
        .collect::<Vec<String>>();
    // The new name of the first item; the list of renames names the rest.
    let destination = items[0].dst_path.clone();

    let metadata = JobMetadata::new(remote_name, JobType::Rename, source, destination)
        .with_origin(origin)
        .with_group(group);

    crate::rclone::commands::job::submit_batch_job_with_options(
        app,
        inputs,
        metadata,
        Default::default(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        ExistingFiles, FsItem, TransferMode, TransferOptions, refuse_transfer_into_itself,
        transfer_inputs,
    };
    use serde_json::{Value, json};

    fn item(remote: &str, path: &str, name: &str, is_dir: bool) -> FsItem {
        FsItem {
            remote: remote.into(),
            path: path.into(),
            name: name.into(),
            is_dir,
            existing_files: ExistingFiles::Replace,
        }
    }

    #[test]
    fn a_folder_cannot_go_into_itself_or_a_folder_inside_it() {
        let folder = [item("dropbox:", "test/dfsgh", "dfsgh", true)];
        for inside in ["test/dfsgh", "test/dfsgh/", "/test/dfsgh/sub/deeper"] {
            assert!(
                refuse_transfer_into_itself(&folder, "dropbox:", inside)
                    .unwrap_err()
                    .contains("backendErrors.file.intoItself"),
                "{inside}"
            );
        }
        // Beside it, above it, a name that only starts the same or another remote: fine.
        for (remote, outside) in [
            ("dropbox:", "test"),
            ("dropbox:", ""),
            ("dropbox:", "test/dfsgh (2)"),
            ("dropbox:", "test/dfsghx/sub"),
            ("drive:", "test/dfsgh"),
        ] {
            assert!(refuse_transfer_into_itself(&folder, remote, outside).is_ok());
        }
        // A file may go anywhere; a local folder is compared by its path.
        let file = [item("dropbox:", "test/a.txt", "a.txt", false)];
        assert!(refuse_transfer_into_itself(&file, "dropbox:", "test/a.txt").is_ok());
        let local = [item("/home/me/Photos", "", "Photos", true)];
        assert!(refuse_transfer_into_itself(&local, "/", "home/me/Photos/2026").is_err());
        assert!(refuse_transfer_into_itself(&local, "/", "home/me").is_ok());
    }

    #[test]
    fn an_item_lands_under_its_new_name_and_a_merge_can_keep_what_exists() {
        let items = [
            FsItem {
                existing_files: ExistingFiles::Keep,
                ..item("src:", "docs", "docs", true)
            },
            item("src:", "a.txt", "a (2).txt", false),
        ];
        assert_eq!(
            transfer_inputs(&items, "dst:", "", TransferMode::Copy),
            [
                // The folder exists already; creating it again changes nothing.
                json!({"_path": "operations/mkdir", "fs": "dst:", "remote": "docs"}),
                json!({
                    "_path": "sync/copy",
                    "srcFs": "src:docs",
                    "dstFs": "dst:docs",
                    "createEmptySrcDirs": true,
                    "ignore_existing": true,
                }),
                json!({
                    "_path": "operations/copyfile",
                    "srcFs": "src:",
                    "srcRemote": "a.txt",
                    "dstFs": "dst:",
                    "dstRemote": "a (2).txt",
                }),
            ]
        );
        let moved = transfer_inputs(&items[..1], "dst:", "", TransferMode::Move);
        assert_eq!(moved[0]["ignore_existing"], json!(true));

        // Keeping the newer of each file is rclone's --update.
        let newer = [FsItem {
            existing_files: ExistingFiles::Newer,
            ..item("src:", "docs", "docs", true)
        }];
        let inputs = transfer_inputs(&newer, "dst:", "", TransferMode::Copy);
        assert_eq!(inputs[1]["update"], json!(true));
        assert!(inputs[1].get("ignore_existing").is_none());
        assert!(inputs[0].get("update").is_none());
        let wire: FsItem = serde_json::from_value(json!({
            "remote": "src:", "path": "docs", "isDir": true, "existingFiles": "newer"
        }))
        .unwrap();
        assert_eq!(wire.existing_files, ExistingFiles::Newer);
    }

    #[test]
    fn copied_folders_are_created_before_their_contents_are_copied() {
        let items = [
            item("src:", "docs", "docs", true),
            item("src:", "a/b.txt", "b.txt", false),
        ];
        assert_eq!(
            transfer_inputs(&items, "dst:", "target/", TransferMode::Copy),
            [
                json!({"_path": "operations/mkdir", "fs": "dst:", "remote": "target/docs"}),
                json!({
                    "_path": "sync/copy",
                    "srcFs": "src:docs",
                    "dstFs": "dst:target/docs",
                    "createEmptySrcDirs": true,
                }),
                json!({
                    "_path": "operations/copyfile",
                    "srcFs": "src:a",
                    "srcRemote": "b.txt",
                    "dstFs": "dst:target",
                    "dstRemote": "b.txt",
                }),
            ]
        );
    }

    #[test]
    fn moves_need_no_mkdir_and_the_root_destination_keeps_bare_names() {
        let items = [
            item("src:", "docs", "docs", true),
            item("src:", "b.txt", "b.txt", false),
        ];
        assert_eq!(
            transfer_inputs(&items, "dst:", "", TransferMode::Move),
            [
                json!({
                    "_path": "sync/move",
                    "srcFs": "src:docs",
                    "dstFs": "dst:docs",
                    "createEmptySrcDirs": true,
                    "deleteEmptySrcDirs": true,
                }),
                json!({
                    "_path": "operations/movefile",
                    "srcFs": "src:",
                    "srcRemote": "b.txt",
                    "dstFs": "dst:",
                    "dstRemote": "b.txt",
                }),
            ]
        );
        assert!(transfer_inputs(&[], "dst:", "", TransferMode::Copy).is_empty());
    }

    #[test]
    fn transfer_modes_reject_unknown_values_before_execution() {
        assert_eq!(
            serde_json::from_str::<TransferMode>("\"copy\"").unwrap(),
            TransferMode::Copy
        );
        assert_eq!(
            serde_json::from_str::<TransferMode>("\"move\"").unwrap(),
            TransferMode::Move
        );
        for value in ["\"Copy\"", "\"cut\"", "\"\"", "null", "0"] {
            assert!(serde_json::from_str::<TransferMode>(value).is_err());
        }
    }

    #[test]
    fn transfer_options_become_flat_options_config_and_filter_blocks() {
        let values = json!({
            "copy": {"check_first": true, "--max-transfer": "1G"},
            "move": {"delete_empty_src_dirs": true},
            "filter": {"exclude": ["*.tmp"], "MinSize": "1k"},
            "backend": {"transfers": 8, "LowLevelRetries": 20, "BwLimit": ""},
            "sync": {"track_renames": true},
        });
        let copy = TransferOptions::from_values(&values, TransferMode::Copy);
        assert_eq!(
            Value::Object(copy.options.clone()),
            json!({
                "check_first": true,
                "max_transfer": "1G",
                "exclude": ["*.tmp"],
                "transfers": 8,
                "_filter": {"MinSize": "1k"},
                "_config": {"LowLevelRetries": 20},
            })
        );
        assert_eq!(
            copy.summary().as_deref(),
            Some("LowLevelRetries, MinSize, check_first, exclude, max_transfer, transfers")
        );
        let moved = TransferOptions::from_values(&values, TransferMode::Move);
        assert_eq!(moved.options["delete_empty_src_dirs"], true);
        assert!(!moved.options.contains_key("check_first"));
        for empty in [json!({}), Value::Null] {
            let options = TransferOptions::from_values(&empty, TransferMode::Copy);
            assert!(options.options.is_empty() && options.remotes.is_empty());
            assert_eq!(options.summary(), None);
        }
    }

    #[test]
    fn a_remote_s_options_go_on_the_paths_that_name_it() {
        let options = TransferOptions::from_values(
            &json!({"remotes": {"drive": {"chunk_size": "64M", "acknowledge_abuse": true}}}),
            TransferMode::Copy,
        );
        assert_eq!(
            options.summary().as_deref(),
            Some("drive: acknowledge_abuse, drive: chunk_size")
        );
        let inputs = transfer_inputs(
            &[
                item("drive:", "a.txt", "a.txt", false),
                item("/home", "b", "b", true),
            ],
            "drive:",
            "dest",
            TransferMode::Copy,
        );
        let requests: Vec<Value> = inputs
            .into_iter()
            .map(|input| {
                let Value::Object(request) = input else {
                    panic!("{input}")
                };
                Value::Object(options.apply_remotes(request).unwrap())
            })
            .collect();
        let named = "drive,acknowledge_abuse='true',chunk_size='64M':";
        assert_eq!(requests[0]["srcFs"], named);
        assert_eq!(requests[0]["dstFs"], format!("{named}dest"));
        // A local path names no remote and stays as it is.
        assert_eq!(requests[2]["srcFs"], "/home/b");
        assert_eq!(requests[2]["dstFs"], format!("{named}dest/b"));
        let invalid = TransferOptions::from_values(
            &json!({"remotes": {"drive": {"bad key": 1}}}),
            TransferMode::Copy,
        );
        // An option name rclone could not read is refused, not passed on.
        assert!(invalid.apply_remotes(serde_json::Map::new()).is_err());
    }
}
