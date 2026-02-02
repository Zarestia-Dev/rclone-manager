//! VFS handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;

use crate::server::state::{ApiResponse, AppError, WebServerState};

pub async fn vfs_list_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs_list;
    let value = vfs_list(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct VfsForgetBody {
    pub fs: Option<String>,
    pub file: Option<String>,
}

pub async fn vfs_forget_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsForgetBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs_forget;
    let value = vfs_forget(state.app_handle.clone(), body.fs, body.file)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct VfsRefreshBody {
    pub fs: Option<String>,
    pub dir: Option<String>,
    #[serde(default)]
    pub recursive: bool,
}

pub async fn vfs_refresh_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsRefreshBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs_refresh;
    let value = vfs_refresh(state.app_handle.clone(), body.fs, body.dir, body.recursive)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct VfsStatsQuery {
    pub fs: Option<String>,
}

pub async fn vfs_stats_handler(
    State(state): State<WebServerState>,
    Query(query): Query<VfsStatsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs_stats;
    let value = vfs_stats(state.app_handle.clone(), query.fs)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct VfsPollIntervalBody {
    pub fs: Option<String>,
    pub interval: Option<String>,
    pub timeout: Option<String>,
}

pub async fn vfs_poll_interval_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsPollIntervalBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs_poll_interval;
    let value = vfs_poll_interval(
        state.app_handle.clone(),
        body.fs,
        body.interval,
        body.timeout,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct VfsQueueQuery {
    pub fs: Option<String>,
}

pub async fn vfs_queue_handler(
    State(state): State<WebServerState>,
    Query(query): Query<VfsQueueQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs_queue;
    let value = vfs_queue(state.app_handle.clone(), query.fs)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct VfsQueueSetExpiryBody {
    pub fs: Option<String>,
    pub id: u64,
    pub expiry: f64,
    #[serde(default)]
    pub relative: bool,
}

pub async fn vfs_queue_set_expiry_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsQueueSetExpiryBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs_queue_set_expiry;
    let value = vfs_queue_set_expiry(
        state.app_handle.clone(),
        body.fs,
        body.id,
        body.expiry,
        body.relative,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}
