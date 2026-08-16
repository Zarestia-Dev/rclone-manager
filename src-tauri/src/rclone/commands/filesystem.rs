use log::debug;

use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;

use crate::rclone::commands::job::JobMetadata;
use crate::utils::json_helpers::build_full_path;
use crate::utils::rclone::endpoints::{operations, sync};
use crate::utils::types::{jobs::JobType, origin::Origin};

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

#[tauri::command]
pub async fn mkdir(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    debug!("mkdir: remote={remote} path={path}");

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
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
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

    let metadata = JobMetadata::for_query(remote, path_str, JobType::Cleanup, origin, group);
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        operations::CLEANUP,
        json!(payload),
        metadata,
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
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
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
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

    let metadata = JobMetadata::for_query(remote, path, JobType::Rmdirs, origin, group);
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        operations::RMDIRS,
        payload,
        metadata,
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer(
    app: AppHandle,
    items: Vec<FsItem>,
    dst_remote: String,
    dst_path: String,
    mode: String,
    origin: Option<Origin>,
    group: Option<String>,
    parent_job_id: Option<u64>,
) -> Result<String, String> {
    let dst_path = if dst_path == "/" {
        String::new()
    } else {
        dst_path
    };

    debug!(
        "transfer: {} items to {dst_remote}:{dst_path} (mode={mode})",
        items.len()
    );

    let mut inputs = Vec::new();
    for item in &items {
        let dst_file = if dst_path.is_empty() {
            item.name.clone()
        } else {
            format!("{}/{}", dst_path.trim_end_matches('/'), item.name)
        };

        let src_full = build_full_path(&item.remote, &item.path);
        let dst_full = build_full_path(&dst_remote, &dst_file);

        if mode == "copy" {
            if item.is_dir {
                inputs.push(json!({
                    "_path": sync::COPY,
                    "srcFs": src_full,
                    "dstFs": dst_full,
                    "createEmptySrcDirs": true,
                }));
            } else {
                inputs.push(json!({
                    "_path": operations::COPYFILE,
                    "srcFs": item.remote,
                    "srcRemote": item.path,
                    "dstFs": dst_remote.clone(),
                    "dstRemote": dst_file,
                }));
            }
        } else if item.is_dir {
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
                "srcRemote": item.path,
                "dstFs": dst_remote.clone(),
                "dstRemote": dst_file,
            }));
        }
    }

    let job_type = if mode == "move" {
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

    crate::rclone::commands::job::submit_batch_job(app, inputs, metadata).await
}

#[tauri::command]
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

    crate::rclone::commands::job::submit_batch_job(app, inputs, metadata).await
}

#[tauri::command]
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

    crate::rclone::commands::job::submit_batch_job(app, inputs, metadata).await
}
