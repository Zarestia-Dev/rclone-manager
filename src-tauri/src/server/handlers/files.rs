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
    State(state): State<WebServerState>,
    Query(query): Query<ConvertFileSrcQuery>,
) -> Result<impl IntoResponse, AppError> {
    use crate::rclone::backend::BackendManager;
    use crate::utils::types::core::RcloneState;
    use tracing::debug;

    let path_str = query.path.clone();
    let path = std::path::PathBuf::from(&path_str);

    // 1. Try standard file opening first
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
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .replace(
                    |c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_' && c != ' ',
                    "_",
                );

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
        Err(e) => {
            // 2. Fallback to rclone cat
            debug!(
                "⚠️ Standard stream failed for {}, attempting cat fallback: {}",
                path_str, e
            );
            let backend_manager = state.app_handle.state::<BackendManager>();
            let backend = backend_manager.get_active().await;
            let rclone_state = state.app_handle.state::<RcloneState>();
            let os = backend_manager.get_runtime_os(&backend.name).await;

            // For local files on the manager machine, we use an empty remote or ":"
            match backend
                .fetch_file_via_cat(&rclone_state.client, "", &path_str, None, None, os)
                .await
            {
                Ok(bytes) => {
                    let mime_type = mime_guess::from_path(&path).first_or_octet_stream();
                    let mut builder = axum::response::Response::builder()
                        .header(header::CONTENT_TYPE, mime_type.as_ref());

                    let filename = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("file")
                        .replace(
                            |c: char| {
                                !c.is_alphanumeric() && c != '.' && c != '-' && c != '_' && c != ' '
                            },
                            "_",
                        );

                    let disposition_type = if query.download.unwrap_or(false) {
                        "attachment"
                    } else {
                        "inline"
                    };
                    builder = builder.header(
                        header::CONTENT_DISPOSITION,
                        format!("{disposition_type}; filename=\"{filename}\""),
                    );

                    builder.body(axum::body::Body::from(bytes)).map_err(|e| {
                        AppError::InternalServerError(anyhow::Error::msg(e.to_string()))
                    })
                }
                Err(cat_err) => {
                    error!("❌ Cat fallback also failed for {}: {}", path_str, cat_err);

                    if cat_err.contains("not found") || cat_err.contains("directory not found") {
                        Err(AppError::NotFound(cat_err))
                    } else if cat_err.contains("being used by another process")
                        || cat_err.contains("Access is denied")
                    {
                        Err(AppError::BadRequest(anyhow::anyhow!(cat_err)))
                    } else {
                        Err(AppError::InternalServerError(anyhow::anyhow!(cat_err)))
                    }
                }
            }
        }
    }
}
