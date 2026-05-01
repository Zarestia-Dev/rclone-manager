//! Audio cover handlers for the web server.

use crate::server::state::{AppError, WebServerState};
use crate::utils::app::audio;
use axum::http::header;
use axum::{
    extract::{Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use std::path::Path;
use tauri::Manager;

#[derive(Deserialize)]
pub struct AudioCoverQuery {
    pub path: String,
    pub remote: Option<String>,
}

pub async fn audio_cover_handler(
    State(state): State<WebServerState>,
    Query(query): Query<AudioCoverQuery>,
) -> Result<impl IntoResponse, AppError> {
    // Extension hint helps lofty identify the format from raw bytes
    let extension = Path::new(&query.path)
        .extension()
        .and_then(|ext| ext.to_str());

    if let Some(mut remote) = query.remote {
        // Ensure remote ends with a colon for rclone
        if !remote.ends_with(':') {
            remote.push(':');
        }

        use crate::rclone::backend::BackendManager;
        let backend_manager = state.app_handle.state::<BackendManager>();
        let backend = backend_manager.get_active().await;

        let rclone_state = state
            .app_handle
            .state::<crate::utils::types::core::RcloneState>();
        let client = &rclone_state.client;

        // Fetch first 10MB (fast and covers almost all embedded covers)
        let response = backend
            .fetch_file_stream_with_range(client, &remote, &query.path, Some("bytes=0-10485760"))
            .await
            .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;

        if !response.status().is_success() {
            return Err(AppError::NotFound(format!(
                "Remote file not found: {}",
                response.status()
            )));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;

        if let Some(pic) = audio::extract_picture_from_bytes(&bytes, extension) {
            Ok(axum::response::Response::builder()
                .header(header::CONTENT_TYPE, pic.mime_type)
                .header(header::CACHE_CONTROL, "max-age=3600")
                .body(axum::body::Body::from(pic.data))
                .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?)
        } else {
            Err(AppError::NotFound("Audio cover not found".to_string()))
        }
    } else {
        // Local file extraction
        if let Some(pic) = audio::extract_picture_from_path(&query.path) {
            Ok(axum::response::Response::builder()
                .header(header::CONTENT_TYPE, pic.mime_type)
                .header(header::CACHE_CONTROL, "max-age=3600")
                .body(axum::body::Body::from(pic.data))
                .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?)
        } else {
            Err(AppError::NotFound("Audio cover not found".to_string()))
        }
    }
}
