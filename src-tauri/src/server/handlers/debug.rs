//! Debug handlers for troubleshooting (headless/web-server mode)
//!
//! Note: open_devtools is not needed here - web browser has its own F12 DevTools!

use axum::{extract::State, response::Json};

use crate::core::debug::DebugInfo;
use crate::server::state::{ApiResponse, AppError, WebServerState};

/// Get debug information (paths, versions, build info)
pub async fn get_debug_info_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<DebugInfo>>, AppError> {
    // Reuse central logic from core::debug
    // Note: get_debug_info is a Tauri command but also a regular public function
    let info = crate::core::debug::get_debug_info(state.app_handle.clone())
        .map_err(|e| AppError::InternalServerError(anyhow::anyhow!(e)))?;

    Ok(Json(ApiResponse::success(info)))
}
