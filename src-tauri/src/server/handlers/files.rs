//! File operation handlers (streaming, etc.)

use axum::http::header;
use axum::{
    extract::{Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use tauri::Manager;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::server::state::{AppError, WebServerState};

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
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let rclone_state = state
        .app_handle
        .state::<crate::utils::types::core::RcloneState>();
    let client = &rclone_state.client;

    let response = backend
        .fetch_file_stream(client, &query.remote, &query.path)
        .await
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;

    if !response.status().is_success() {
        return Err(AppError::BadRequest(anyhow::Error::msg(format!(
            "Failed to fetch remote file ({}): {}/{}",
            response.status(),
            query.remote,
            query.path
        ))));
    }

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let body = axum::body::Body::from_stream(response.bytes_stream());

    let mut builder =
        axum::response::Response::builder().header(header::CONTENT_TYPE, content_type);

    // Extract filename from path and clean it
    let filename = query.path.split('/').next_back().unwrap_or("file").replace(
        |c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_' && c != ' ',
        "_",
    );

    // Always provide the filename. Use 'attachment' for forced downloads, 'inline' for streaming.
    let disposition_type = if query.download.unwrap_or(false) {
        "attachment"
    } else {
        "inline"
    };
    builder = builder.header(
        header::CONTENT_DISPOSITION,
        format!("{disposition_type}; filename=\"{filename}\""),
    );

    builder
        .body(body)
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
}

#[derive(Deserialize)]
pub struct ConvertFileSrcQuery {
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_file_handler(
    Query(query): Query<ConvertFileSrcQuery>,
) -> Result<impl IntoResponse, AppError> {
    let path = std::path::PathBuf::from(&query.path);
    if !path.exists() {
        return Err(AppError::NotFound(
            "backendErrors.filesystem.notFound".to_string(),
        ));
    }

    let file = File::open(&path).await.map_err(anyhow::Error::msg)?;
    let stream = ReaderStream::new(file);
    let body = axum::body::Body::from_stream(stream);

    let mime_type = mime_guess::from_path(&path).first_or_octet_stream();

    let mut builder =
        axum::response::Response::builder().header(header::CONTENT_TYPE, mime_type.as_ref());

    // Extract filename from path and clean it
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .replace(
            |c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_' && c != ' ',
            "_",
        );

    // Always provide the filename. Use 'attachment' for forced downloads, 'inline' for streaming.
    let disposition_type = if query.download.unwrap_or(false) {
        "attachment"
    } else {
        "inline"
    };
    builder = builder.header(
        header::CONTENT_DISPOSITION,
        format!("{disposition_type}; filename=\"{filename}\""),
    );

    builder
        .body(body)
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
}
