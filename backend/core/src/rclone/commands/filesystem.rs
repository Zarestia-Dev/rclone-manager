use log::debug;

use crate::context::AppHandle;
use serde::Deserialize;
use serde_json::json;

use crate::rclone::commands::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};
use crate::rclone::commands::sync::lookup_dry_run;
use crate::rclone::endpoints::operations;
use crate::rclone::endpoints::sync;
use crate::services::settings::operations::templates::{TransferOptions, transfer_options};
use crate::utils::json_helpers::build_full_path;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::OperationType;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsItem {
    pub remote: String,
    pub path: String,
    #[serde(default)]
    pub name: String,
    pub is_dir: bool,
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

    let payload = json!({
        "fs": &remote,
        "remote": &path,
        "_async": true,
    });

    let metadata = JobMetadata::for_mutation(remote, vec![path], "", JobType::Mkdir, origin, group);
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        operations::MKDIR,
        payload,
        metadata,
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
            backend: Some(backend),
        },
    )
    .await?;

    Ok(())
}

pub async fn cleanup(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let path_str = path.as_deref().unwrap_or("");
    debug!("cleanup: remote={remote} path={path_str}");

    let mut payload = serde_json::Map::new();
    payload.insert("fs".to_string(), json!(&remote));
    if let Some(ref p) = path {
        payload.insert("remote".to_string(), json!(p));
    }
    payload.insert("_async".to_string(), json!(true));

    let metadata = JobMetadata::for_mutation(
        remote,
        vec![path_str.to_string()],
        "",
        JobType::Cleanup,
        origin,
        group,
    );
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        operations::CLEANUP,
        json!(payload),
        metadata,
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
            ..Default::default()
        },
    )
    .await?;

    Ok(())
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
        "_async": true,
    });

    let metadata = JobMetadata::for_mutation(
        remote,
        vec![url_to_copy],
        path,
        JobType::CopyUrl,
        origin,
        group,
    )
    .with_execute_id(Some(uuid::Uuid::new_v4().to_string()));
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        operations::COPYURL,
        payload,
        metadata,
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
            ..Default::default()
        },
    )
    .await?;

    Ok(())
}

pub async fn remove_empty_dirs(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    debug!("remove_empty_dirs: remote={remote} path={path}");

    let payload = json!({
        "fs": &remote,
        "remote": &path,
        "leaveRoot": true,
        "_async": true,
    });

    let metadata =
        JobMetadata::for_mutation(remote, vec![path], "", JobType::Rmdirs, origin, group);
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        operations::RMDIRS,
        payload,
        metadata,
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
            ..Default::default()
        },
    )
    .await?;

    Ok(())
}

/// The `job/batch` inputs that copy or move `items` into `dst_path` on `dst_remote`:
/// `copyfile`/`movefile` for a file, `sync/copy`/`sync/move` for a folder.
///
/// A copied folder is created first: `sync/copy` creates nothing for a folder without
/// entries, so an empty folder would not arrive (`sync/move` creates it).
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
            (TransferMode::Copy, false) => inputs.push(json!({
                "_path": operations::COPYFILE,
                "srcFs": item.remote,
                "srcRemote": item.path,
                "dstFs": dst_remote,
                "dstRemote": dst_file,
            })),
            (TransferMode::Move, true) => inputs.push(json!({
                "_path": sync::MOVE,
                "srcFs": src_full,
                "dstFs": dst_full,
                "createEmptySrcDirs": true,
                "deleteEmptySrcDirs": true,
            })),
            (TransferMode::Move, false) => inputs.push(json!({
                "_path": operations::MOVEFILE,
                "srcFs": item.remote,
                "srcRemote": item.path,
                "dstFs": dst_remote,
                "dstRemote": dst_file,
            })),
        }
    }
    inputs
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
    template: Option<String>,
) -> Result<String, String> {
    let dst_path = if dst_path == "/" {
        String::new()
    } else {
        dst_path
    };

    debug!(
        "transfer: {} items to {dst_remote}:{dst_path} (mode={mode:?})",
        items.len()
    );

    let inputs = transfer_inputs(&items, &dst_remote, &dst_path, mode);

    let job_type = if mode == TransferMode::Move {
        JobType::Move
    } else {
        JobType::Copy
    };

    let first_item = items
        .first()
        .ok_or_else(|| "No items to transfer".to_string())?;
    let all_same_remote = items.iter().all(|item| item.remote == first_item.remote);
    let remote_name = if all_same_remote {
        first_item.remote.clone()
    } else {
        "multiple".to_string()
    };
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
    .with_parent_job_id(parent_job_id)
    .with_execute_id(Some(uuid::Uuid::new_v4().to_string()));

    let options = transfer_options(&app, template, mode).await;
    submit_transfer_job(app, inputs, options, metadata, Default::default()).await
}

/// Submits the `job/batch` of a file browser copy, move or upload with the options of
/// its template. They sit on the batch, whose settings every input inherits, so its
/// `transfers` also sets how many inputs run at once.
pub(crate) async fn submit_transfer_job(
    app: AppHandle,
    inputs: Vec<serde_json::Value>,
    options: TransferOptions,
    metadata: JobMetadata,
    submit: SubmitJobOptions,
) -> Result<String, String> {
    let mut payload = options.options;
    let dry_run = lookup_dry_run(
        &serde_json::Value::Object(payload.clone()),
        None,
        OperationType::Copy,
    );
    payload.insert("_async".into(), json!(true));
    payload.insert("inputs".into(), json!(inputs));
    submit_job_with_options(
        app,
        crate::rclone::endpoints::job::BATCH,
        serde_json::Value::Object(payload),
        metadata
            .with_template(options.template)
            .with_dry_run(dry_run),
        submit,
    )
    .await
    .map(|submission| submission.job_id.to_string())
}

pub async fn delete(
    app: AppHandle,
    items: Vec<FsItem>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<String, String> {
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

    let first_item = items
        .first()
        .ok_or_else(|| "No items to delete".to_string())?;
    let all_same_remote = items.iter().all(|item| item.remote == first_item.remote);
    let remote_name = if all_same_remote {
        first_item.remote.clone()
    } else {
        "multiple".to_string()
    };
    let source = items
        .iter()
        .map(|item| build_full_path(&item.remote, &item.path))
        .collect::<Vec<String>>();

    let metadata = JobMetadata::new(remote_name, JobType::Delete, source, "trash")
        .with_origin(origin)
        .with_group(group)
        .with_execute_id(Some(uuid::Uuid::new_v4().to_string()));

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
) -> Result<String, String> {
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

    let first_item = items
        .first()
        .ok_or_else(|| "No items to rename".to_string())?;
    let all_same_remote = items.iter().all(|item| item.remote == first_item.remote);
    let remote_name = if all_same_remote {
        first_item.remote.clone()
    } else {
        "multiple".to_string()
    };
    let source = items
        .iter()
        .map(|item| build_full_path(&item.remote, &item.src_path))
        .collect::<Vec<String>>();
    let destination = first_item.dst_path.clone();

    let metadata = JobMetadata::new(remote_name, JobType::Rename, source, destination)
        .with_origin(origin)
        .with_group(group)
        .with_execute_id(Some(uuid::Uuid::new_v4().to_string()));

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
    use super::{FsItem, TransferMode, transfer_inputs};
    use serde_json::json;

    fn item(remote: &str, path: &str, name: &str, is_dir: bool) -> FsItem {
        FsItem {
            remote: remote.into(),
            path: path.into(),
            name: name.into(),
            is_dir,
        }
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
                    "srcFs": "src:",
                    "srcRemote": "a/b.txt",
                    "dstFs": "dst:",
                    "dstRemote": "target/b.txt",
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
}
