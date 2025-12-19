//! VFS handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use tauri::Manager;

use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::all_types::RcloneState;

pub async fn vfs_list_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_list;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let value = vfs_list(rclone_state).await.map_err(anyhow::Error::msg)?;
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
    use crate::rclone::queries::vfs::vfs_forget;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let value = vfs_forget(rclone_state, body.fs, body.file)
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
    use crate::rclone::queries::vfs::vfs_refresh;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let value = vfs_refresh(rclone_state, body.fs, body.dir, body.recursive)
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
    use crate::rclone::queries::vfs::vfs_stats;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let value = vfs_stats(rclone_state, query.fs)
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
    use crate::rclone::queries::vfs::vfs_poll_interval;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let value = vfs_poll_interval(rclone_state, body.fs, body.interval, body.timeout)
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
    use crate::rclone::queries::vfs::vfs_queue;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let value = vfs_queue(rclone_state, query.fs)
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
    use crate::rclone::queries::vfs::vfs_queue_set_expiry;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let value = vfs_queue_set_expiry(rclone_state, body.fs, body.id, body.expiry, body.relative)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}
