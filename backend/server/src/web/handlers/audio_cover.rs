//! Audio cover handlers for the web server.

use std::path::Path;

use crate::utils::io::file_stream::pin_file_transport;

use axum::{
    extract::{Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
};

use serde::Deserialize;
use tokio::io::AsyncReadExt;

use crate::utils::app::audio::{self, PictureData};
use crate::utils::io::http_helpers::{
    MAX_AUDIO_COVER_PROBE_BYTES, classify_error_status, has_parent_path_component,
};
use crate::utils::types::state::RcloneState;
use crate::web::state::{AppError, WebServerState};

#[derive(Deserialize)]
pub struct AudioCoverQuery {
    pub path: String,
    pub remote: Option<String>,
}

pub async fn audio_cover_handler(
    State(state): State<WebServerState>,
    Query(query): Query<AudioCoverQuery>,
) -> Result<impl IntoResponse, AppError> {
    if has_parent_path_component(&query.path) {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Path traversal denied"
        )));
    }

    if let Some(raw_remote) = query.remote {
        let _input_permit = audio::cover_input_permit().await.ok_or_else(|| {
            AppError::InternalServerError(anyhow::anyhow!("Cover reader unavailable"))
        })?;
        // Axum already decoded the query string once.
        let remote = if raw_remote.ends_with(':') {
            raw_remote
        } else {
            format!("{raw_remote}:")
        };

        let rclone_state = state.app_handle.state::<RcloneState>();
        let transport = rclone_state.transport.clone();

        let transport = pin_file_transport(transport)
            .await
            .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?;
        let reader = transport
            .read_file(
                &remote,
                &query.path,
                Some((0, Some(MAX_AUDIO_COVER_PROBE_BYTES - 1))),
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
            .take(MAX_AUDIO_COVER_PROBE_BYTES)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?;

        let extension = Path::new(&query.path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_owned);
        let picture = audio::extract_picture_from_bytes(bytes, extension).await;
        if let Some(pic) = picture {
            picture_response(pic)
        } else {
            Err(AppError::NotFound("Audio cover not found".to_string()))
        }
    } else {
        // Local file extraction
        let picture = audio::extract_picture_from_path(query.path).await;
        if let Some(pic) = picture {
            picture_response(pic)
        } else {
            Err(AppError::NotFound("Audio cover not found".to_string()))
        }
    }
}

fn picture_response(pic: PictureData) -> Result<axum::response::Response, AppError> {
    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, pic.mime_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(pic.data))
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
}
