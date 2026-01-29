//! Flag handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use std::collections::HashMap;

use crate::server::state::{ApiResponse, AppError, WebServerState};

pub async fn get_grouped_options_with_values_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_grouped_options_with_values;
    let options = get_grouped_options_with_values(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(options)))
}

pub async fn get_mount_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_mount_flags;
    let flags = get_mount_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_copy_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_copy_flags;
    let flags = get_copy_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_sync_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_sync_flags;
    let flags = get_sync_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_bisync_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_bisync_flags;
    let flags = get_bisync_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_move_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_move_flags;
    let flags = get_move_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_filter_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_filter_flags;
    let flags = get_filter_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_vfs_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_vfs_flags;
    let flags = get_vfs_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_backend_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_backend_flags;
    let flags = get_backend_flags(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

pub async fn get_option_blocks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_option_blocks;
    let blocks = get_option_blocks(state.app_handle.clone())
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
    let flags = get_flags_by_category(
        state.app_handle.clone(),
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
    let types = get_serve_types(state.app_handle.clone())
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
    let serve_type = params
        .get("serveType")
        .cloned()
        .or_else(|| params.get("serve_type").cloned());
    let flags = get_serve_flags(state.app_handle.clone(), serve_type)
        .await
        .map_err(anyhow::Error::msg)?;
    let value = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}
