//! Streaming upload handlers for the web server.

use axum::{
    extract::{Multipart, State},
    response::Json,
};
use futures::StreamExt;
use log::{debug, error};
use tauri::Manager;

use crate::rclone::backend::BackendManager;
use crate::rclone::commands::job::JobMetadata;
use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::app::notification::notify;
use crate::utils::rclone::endpoints::operations;
use crate::utils::types::core::RcloneState;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;
use serde_json::json;

struct BatchMeta {
    id: String,
    file_index: usize,
    total_files: usize,
}

pub async fn stream_upload_handler(
    State(state): State<WebServerState>,
    mut multipart: Multipart,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let (mut remote, mut path) = (String::new(), String::new());
    let (mut origin, mut job_id) = (None, None);
    let (mut raw_batch_id, mut raw_file_index, mut raw_total_files) = (None, None, None);

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(anyhow::Error::msg(e.to_string())))?
    {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "remote" => remote = field.text().await.unwrap_or_default(),
            "path" => path = field.text().await.unwrap_or_default(),
            "origin" => origin = serde_json::from_str(&field.text().await.unwrap_or_default()).ok(),
            "batchId" => raw_batch_id = Some(field.text().await.unwrap_or_default()),
            "jobId" => job_id = field.text().await.unwrap_or_default().parse().ok(),
            "fileIndex" => raw_file_index = field.text().await.unwrap_or_default().parse().ok(),
            "totalFiles" => raw_total_files = field.text().await.unwrap_or_default().parse().ok(),
            "file" => {
                let filename = field.file_name().unwrap_or("unnamed").replace('\\', "/");
                let batch = match (raw_batch_id, raw_file_index, raw_total_files) {
                    (Some(id), Some(idx), Some(total)) => Some(BatchMeta {
                        id,
                        file_index: idx,
                        total_files: total,
                    }),
                    _ => None,
                };

                let temp_dir = std::env::temp_dir();
                let (batch_dir, temp_path) = if let Some(ref b) = batch {
                    let dir = temp_dir.join(format!("rclone_batch_{}", b.id));
                    tokio::fs::create_dir_all(&dir).await.ok();
                    if let Some(p) = std::path::Path::new(&filename).parent() {
                        if !p.as_os_str().is_empty() {
                            tokio::fs::create_dir_all(dir.join(p)).await.ok();
                        }
                    }
                    (Some(dir.clone()), dir.join(&filename))
                } else {
                    (
                        None,
                        temp_dir.join(format!("upload_{}.tmp", uuid::Uuid::new_v4())),
                    )
                };

                let mut file = tokio::fs::File::create(&temp_path)
                    .await
                    .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
                let mut stream = field;
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| AppError::BadRequest(anyhow::Error::msg(e)))?;
                    tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                        .await
                        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
                }
                drop(file);

                if let Some(ref b) = batch {
                    if b.file_index < b.total_files - 1 {
                        return Ok(Json(ApiResponse::success("File buffered".into())));
                    }
                    let bdir = batch_dir.expect("batch_dir present in batch mode");
                    let mut entries = Vec::new();
                    let mut reader = tokio::fs::read_dir(&bdir)
                        .await
                        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
                    while let Some(entry) = reader.next_entry().await.ok().flatten() {
                        entries.push(entry.path().to_string_lossy().to_string());
                    }

                    let res = crate::rclone::commands::filesystem::execute_upload_batch(
                        state.app_handle.clone(),
                        crate::rclone::commands::filesystem::UploadBatchParams {
                            remote,
                            path,
                            local_paths: entries,
                            origin,
                            group: None,
                            cleanup_dir: Some(bdir),
                            existing_jobid: job_id,
                        },
                    )
                    .await
                    .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
                    return Ok(Json(ApiResponse::success(res)));
                }

                let res = crate::rclone::commands::filesystem::execute_upload_batch(
                    state.app_handle.clone(),
                    crate::rclone::commands::filesystem::UploadBatchParams {
                        remote,
                        path,
                        local_paths: vec![temp_path.to_string_lossy().to_string()],
                        origin,
                        group: None,
                        cleanup_dir: Some(temp_path),
                        existing_jobid: job_id,
                    },
                )
                .await
                .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
                return Ok(Json(ApiResponse::success(res)));
            }
            _ => {}
        }
    }
    Err(AppError::BadRequest(anyhow::Error::msg("No file found")))
}
