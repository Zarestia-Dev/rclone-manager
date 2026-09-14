//! Audio cover handlers for the web server.

use std::path::Path;

use axum::{
    extract::{Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
};
use serde::Deserialize;
use tauri::Manager;
use tokio::io::AsyncReadExt;

use crate::server::state::{AppError, WebServerState};
use crate::utils::app::audio::{self, PictureData};
use crate::utils::io::http_helpers::{
    MAX_AUDIO_COVER_PROBE_BYTES, classify_error_status, decode_remote_name,
};
use crate::utils::types::state::RcloneState;

#[derive(Deserialize)]
pub struct AudioCoverQuery {
    pub path: String,
    pub remote: Option<String>,
}

pub async fn audio_cover_handler(
    State(state): State<WebServerState>,
    Query(query): Query<AudioCoverQuery>,
) -> Result<impl IntoResponse, AppError> {
    if query.path.contains("..") {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Path traversal denied"
        )));
    }

    // Extension hint helps lofty identify the format from raw bytes
    let extension = Path::new(&query.path)
        .extension()
        .and_then(|ext| ext.to_str());

    if let Some(raw_remote) = query.remote {
        let remote = decode_remote_name(&raw_remote);

        let rclone_state = state.app_handle.state::<RcloneState>();
        let transport = rclone_state.transport.clone();

        let mut reader = transport
            .read_file(
                &remote,
                &query.path,
                Some((0, Some(MAX_AUDIO_COVER_PROBE_BYTES))),
            )
            .await
            .map_err(|e| {
                let err_msg = e.to_string();
                let status = classify_error_status(&err_msg);
                match status {
                    StatusCode::NOT_FOUND => AppError::NotFound(err_msg),
                    _ => AppError::InternalServerError(anyhow::anyhow!(err_msg)),
                }
            })?;

        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?;

        if let Some(pic) = audio::extract_picture_from_bytes(&bytes, extension) {
            picture_response(pic)
        } else {
            Err(AppError::NotFound("Audio cover not found".to_string()))
        }
    } else {
        // Local file extraction
        if let Some(pic) = audio::extract_picture_from_path(&query.path) {
            picture_response(pic)
        } else {
            Err(AppError::NotFound("Audio cover not found".to_string()))
        }
    }
}

fn picture_response(pic: PictureData) -> Result<axum::response::Response, AppError> {
    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, pic.mime_type)
        .header(header::CACHE_CONTROL, "max-age=3600")
        .body(axum::body::Body::from(pic.data))
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
}
