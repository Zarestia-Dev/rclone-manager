//! Audio cover handlers for the web server.

use axum::{
    extract::{Query, State},
    http::header::{CACHE_CONTROL, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use super::common::{classify_failure, reject_parent_components};
use crate::utils::app::audio::{self, RemoteCoverError};
use crate::utils::io::http_helpers::{ensure_remote_colon, normalize_asset_path};
use crate::utils::types::state::RcloneState;
use crate::web::state::{AppError, WebServerState};

#[derive(Deserialize)]
pub struct AudioCoverQuery {
    path: String,
    remote: Option<String>,
}

pub async fn audio_cover_handler(
    State(state): State<WebServerState>,
    Query(query): Query<AudioCoverQuery>,
) -> Result<Response, AppError> {
    reject_parent_components(&query.path)?;

    let picture = match query.remote {
        // Axum already decoded the query string once.
        Some(remote) => {
            let transport = state.app_handle.state::<RcloneState>().transport.clone();
            audio::extract_remote_cover(transport, &ensure_remote_colon(&remote), &query.path)
                .await
                .map_err(|error| match error {
                    RemoteCoverError::Unavailable => AppError::internal("Cover reader unavailable"),
                    RemoteCoverError::Transport(message) => classify_failure(message),
                })?
        }
        None => audio::extract_picture_from_path(normalize_asset_path(query.path)).await,
    };
    let picture = picture.ok_or_else(|| AppError::NotFound("Audio cover not found".into()))?;
    Ok((
        [(CONTENT_TYPE, picture.mime_type)],
        [
            (CACHE_CONTROL, "no-store"),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        picture.data,
    )
        .into_response())
}
