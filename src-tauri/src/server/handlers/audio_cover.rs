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

        use crate::rclone::backend::RcloneTransport;
        let rclone_state = state
            .app_handle
            .state::<crate::utils::types::state::RcloneState>();
        let transport = rclone_state.transport.clone();

        let mut reader = transport
            .read_file(&remote, &query.path, Some((0, Some(10_485_760))))
            .await
            .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?;

        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?;

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
