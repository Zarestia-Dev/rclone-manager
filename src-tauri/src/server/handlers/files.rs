//! File operation handlers (streaming, etc.)

use std::path::PathBuf;

use axum::{
    extract::{Query, State},
    http::header,
    response::IntoResponse,
};
use serde::Deserialize;
use tauri::Manager;
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

use crate::server::state::{AppError, WebServerState};
use crate::utils::types::state::RcloneState;

#[derive(Deserialize)]
pub struct StreamRemoteFileQuery {
    pub remote: String,
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_remote_file_handler(
    State(state): State<WebServerState>,
    Query(query): Query<StreamRemoteFileQuery>,
) -> Result<impl IntoResponse, AppError> {
    let rclone_state = state.app_handle.state::<RcloneState>();
    let transport = rclone_state.transport.clone();

    let mut reader = transport
        .read_file(&query.remote, &query.path, None)
        .await
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?;

    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?;

    let content_type = mime_guess::from_path(&query.path)
        .first_or_octet_stream()
        .to_string();

    let mut builder =
        axum::response::Response::builder().header(header::CONTENT_TYPE, content_type);

    let filename = sanitize_filename(query.path.split('/').next_back().unwrap_or("file"));

    builder = builder.header(
        header::CONTENT_DISPOSITION,
        content_disposition(query.download.unwrap_or(false), &filename),
    );

    builder
        .body(axum::body::Body::from(bytes))
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
}

#[derive(Deserialize)]
pub struct StreamFileQuery {
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_file_handler(
    State(state): State<WebServerState>,
    Query(query): Query<StreamFileQuery>,
) -> Result<impl IntoResponse, AppError> {
    let path_str = query.path.clone();
    let path = PathBuf::from(&path_str);

    // Try standard file opening first
    let file_result = if path.exists() {
        File::open(&path).await.map_err(anyhow::Error::msg)
    } else {
        Err(anyhow::anyhow!(
            "File not found or inaccessible via std::fs"
        ))
    };

    match file_result {
        Ok(file) => {
            let stream = ReaderStream::new(file);
            let body = axum::body::Body::from_stream(stream);

            let mime_type = mime_guess::from_path(&path).first_or_octet_stream();

            let mut builder = axum::response::Response::builder()
                .header(header::CONTENT_TYPE, mime_type.as_ref());

            // Extract filename from path and clean it
            let filename =
                sanitize_filename(path.file_name().and_then(|n| n.to_str()).unwrap_or("file"));

            builder = builder.header(
                header::CONTENT_DISPOSITION,
                content_disposition(query.download.unwrap_or(false), &filename),
            );

            builder
                .body(body)
                .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
        }
        Err(e) => {
            // Fallback to rclone cat
            log::debug!(
                "⚠️ Standard stream failed for {}, attempting cat fallback: {}",
                path_str,
                e
            );
            let rclone_state = state.app_handle.state::<RcloneState>();
            let transport = rclone_state.transport.clone();

            match transport.read_file("", &path_str, None).await {
                Ok(mut reader) => {
                    let mut bytes = Vec::new();
                    match reader.read_to_end(&mut bytes).await {
                        Ok(_) => {}
                        Err(e) => {
                            return Err(AppError::InternalServerError(anyhow::anyhow!(
                                "Failed to read fallback stream: {e}"
                            )));
                        }
                    }
                    let mime_type = mime_guess::from_path(&path).first_or_octet_stream();
                    let mut builder = axum::response::Response::builder()
                        .header(header::CONTENT_TYPE, mime_type.as_ref());

                    let filename = sanitize_filename(
                        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
                    );

                    builder = builder.header(
                        header::CONTENT_DISPOSITION,
                        content_disposition(query.download.unwrap_or(false), &filename),
                    );

                    builder.body(axum::body::Body::from(bytes)).map_err(|e| {
                        AppError::InternalServerError(anyhow::Error::msg(e.to_string()))
                    })
                }
                Err(cat_err) => {
                    log::error!("❌ Cat fallback also failed for {}: {}", path_str, cat_err);

                    let err_msg = cat_err.to_string();
                    if err_msg.contains("not found") || err_msg.contains("directory not found") {
                        Err(AppError::NotFound(err_msg))
                    } else if err_msg.contains("being used by another process")
                        || err_msg.contains("Access is denied")
                    {
                        Err(AppError::BadRequest(anyhow::anyhow!(err_msg)))
                    } else {
                        Err(AppError::InternalServerError(anyhow::anyhow!(err_msg)))
                    }
                }
            }
        }
    }
}

fn sanitize_filename(name: &str) -> String {
    name.replace(
        |c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_' && c != ' ',
        "_",
    )
}

fn content_disposition(download: bool, filename: &str) -> String {
    let disposition_type = if download { "attachment" } else { "inline" };
    format!("{disposition_type}; filename=\"{filename}\"")
}
