//! Mount and serve handlers

use axum::{extract::State, response::Json};
use serde::Deserialize;
use tauri::Manager;

use crate::server::handlers::jobs::ProfileParamsBody;
use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::all_types::{ProfileParams, RcloneState, RemoteCache};

pub async fn get_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_mounted_remotes;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let remotes = get_mounted_remotes(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_remotes = serde_json::to_value(remotes)?;
    Ok(Json(ApiResponse::success(json_remotes)))
}

pub async fn get_cached_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    use crate::rclone::state::cache::get_cached_mounted_remotes;

    let backend_manager = &BACKEND_MANAGER;
    let backend = backend_manager
        .get_active()
        .await
        .ok_or_else(|| anyhow::anyhow!("No active backend"))
        .map_err(AppError::Anyhow)?;
    let cache = backend.read().await.remote_cache.clone();

    let mounted_remotes = get_cached_mounted_remotes(cache)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_mounted_remotes = serde_json::to_value(mounted_remotes).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_mounted_remotes)))
}

pub async fn get_cached_serves_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    use crate::rclone::state::cache::get_cached_serves;

    let backend_manager = &BACKEND_MANAGER;
    let backend = backend_manager
        .get_active()
        .await
        .ok_or_else(|| anyhow::anyhow!("No active backend"))
        .map_err(AppError::Anyhow)?;
    let cache = backend.read().await.remote_cache.clone();

    let serves = get_cached_serves(cache).await.map_err(anyhow::Error::msg)?;
    let json_serves = serde_json::to_value(serves).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_serves)))
}

pub async fn get_mount_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_mount_types;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let types = get_mount_types(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_types = serde_json::to_value(types).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_types)))
}

pub async fn mount_remote_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::mount::mount_remote_profile;
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };
    // remote_cache not needed in updated signature
    mount_remote_profile(state.app_handle.clone(), params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote mounted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmountRemoteBody {
    pub mount_point: String,
    pub remote_name: String,
}

pub async fn unmount_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UnmountRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::mount::unmount_remote;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let message = unmount_remote(
        state.app_handle.clone(),
        body.mount_point,
        body.remote_name,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(message)))
}

pub async fn start_serve_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::commands::serve::start_serve_profile;
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };
    let resp = start_serve_profile(state.app_handle.clone(), params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        serde_json::to_value(resp).unwrap(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopServeBody {
    pub server_id: String,
    pub remote_name: String,
}

pub async fn stop_serve_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StopServeBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::serve::stop_serve;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let msg = stop_serve(
        state.app_handle.clone(),
        body.server_id,
        body.remote_name,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(msg)))
}
