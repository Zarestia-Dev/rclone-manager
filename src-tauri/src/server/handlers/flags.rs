//! Flag handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use std::collections::HashMap;
use tauri::Manager;

use crate::server::state::{ApiResponse, AppError, WebServerState};
use RcloneState;

pub async fn get_grouped_options_with_values_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_grouped_options_with_values;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let options = get_grouped_options_with_values(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(options)))
}

pub async fn get_mount_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_mount_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_mount_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_copy_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_copy_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_copy_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_sync_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_sync_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_sync_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_bisync_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_bisync_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_bisync_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_move_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_move_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_move_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_filter_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_filter_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_filter_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_vfs_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_vfs_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_vfs_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_backend_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_backend_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_backend_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_option_blocks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_option_blocks;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let blocks = get_option_blocks(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(blocks)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFlagsByCategoryQuery {
    pub category: String,
    pub filter_groups: Option<Vec<String>>,
    pub exclude_flags: Option<Vec<String>>,
}

pub async fn get_flags_by_category_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetFlagsByCategoryQuery>,
) -> Result<Json<ApiResponse<Vec<serde_json::Value>>>, AppError> {
    use crate::rclone::queries::flags::get_flags_by_category;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let flags = get_flags_by_category(
        rclone_state,
        query.category,
        query.filter_groups,
        query.exclude_flags,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(flags)))
}

pub async fn get_serve_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::serve::get_serve_types;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let types = get_serve_types(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let value = serde_json::to_value(types).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

pub async fn get_serve_flags_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_serve_flags;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let serve_type = params
        .get("serveType")
        .cloned()
        .or_else(|| params.get("serve_type").cloned())
        .unwrap_or_default();
    let flags = get_serve_flags(Some(serve_type), rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let value = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}
