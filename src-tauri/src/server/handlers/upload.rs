//! Streaming upload handlers for the web server.

use std::path::{Path, PathBuf};

use axum::{
    extract::{Multipart, State},
    response::Json,
};
use futures::StreamExt;

use crate::rclone::commands::upload::{UploadBatchParams, execute_upload_batch};
use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::origin::Origin;

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
                let batch = build_batch_meta(raw_batch_id, raw_file_index, raw_total_files);

                let temp_dir = std::env::temp_dir();
                let (batch_dir, temp_path) = resolve_temp_path(&temp_dir, &filename, &batch).await;

                write_field_to_file(field, &temp_path).await?;

                if let Some(ref b) = batch {
                    return finalize_batch_upload(
                        &state, b, batch_dir, remote, path, origin, job_id,
                    )
                    .await;
                }

                let params = build_upload_params(
                    remote,
                    path,
                    vec![temp_path.to_string_lossy().to_string()],
                    origin,
                    Some(temp_path),
                    job_id,
                );
                let res = run_upload(&state, params).await?;
                return Ok(Json(ApiResponse::success(res)));
            }
            _ => {}
        }
    }
    Err(AppError::BadRequest(anyhow::Error::msg("No file found")))
}

fn build_batch_meta(
    raw_batch_id: Option<String>,
    raw_file_index: Option<usize>,
    raw_total_files: Option<usize>,
) -> Option<BatchMeta> {
    match (raw_batch_id, raw_file_index, raw_total_files) {
        (Some(id), Some(file_index), Some(total_files)) => Some(BatchMeta {
            id,
            file_index,
            total_files,
        }),
        _ => None,
    }
}

async fn resolve_temp_path(
    temp_dir: &Path,
    filename: &str,
    batch: &Option<BatchMeta>,
) -> (Option<PathBuf>, PathBuf) {
    if let Some(b) = batch {
        let dir = temp_dir.join(format!("rclone_batch_{}", b.id));
        tokio::fs::create_dir_all(&dir).await.ok();
        if let Some(p) = Path::new(filename)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            tokio::fs::create_dir_all(dir.join(p)).await.ok();
        }
        (Some(dir.clone()), dir.join(filename))
    } else {
        (
            None,
            temp_dir.join(format!("upload_{}.tmp", uuid::Uuid::new_v4())),
        )
    }
}

async fn write_field_to_file(
    field: axum::extract::multipart::Field<'_>,
    temp_path: &Path,
) -> Result<(), AppError> {
    let mut file = tokio::fs::File::create(temp_path)
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
    Ok(())
}

async fn finalize_batch_upload(
    state: &WebServerState,
    batch: &BatchMeta,
    batch_dir: Option<PathBuf>,
    remote: String,
    path: String,
    origin: Option<Origin>,
    job_id: Option<u64>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    if batch.file_index < batch.total_files - 1 {
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

    let params = build_upload_params(remote, path, entries, origin, Some(bdir), job_id);
    let res = run_upload(state, params).await?;
    Ok(Json(ApiResponse::success(res)))
}

fn build_upload_params(
    remote: String,
    path: String,
    local_paths: Vec<String>,
    origin: Option<Origin>,
    cleanup_dir: Option<PathBuf>,
    existing_jobid: Option<u64>,
) -> UploadBatchParams {
    UploadBatchParams {
        remote,
        path,
        local_paths,
        origin,
        group: None,
        cleanup_dir,
        existing_jobid,
        no_cache: false,
    }
}

async fn run_upload(state: &WebServerState, params: UploadBatchParams) -> Result<String, AppError> {
    execute_upload_batch(state.app_handle.clone(), params)
        .await
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))
}
