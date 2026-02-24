//! Mount and serve handlers

use axum::{extract::State, response::Json};
use serde::Deserialize;
use tauri::Manager;

use crate::server::handlers::jobs::ProfileParamsBody;
use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::remotes::ProfileParams;

pub async fn get_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_mounted_remotes;
    let remotes = get_mounted_remotes(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_remotes = serde_json::to_value(remotes)?;
    Ok(Json(ApiResponse::success(json_remotes)))
}

pub async fn get_cached_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_cached_mounted_remotes;

    let mounted_remotes = get_cached_mounted_remotes(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_mounted_remotes = serde_json::to_value(mounted_remotes).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_mounted_remotes)))
}

pub async fn get_cached_serves_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_cached_serves;

    let serves = get_cached_serves(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_serves = serde_json::to_value(serves).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_serves)))
}

pub async fn get_mount_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_mount_types;
    let types = get_mount_types(state.app_handle.clone())
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
    let remote_name = body.params.remote_name.clone();
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
        source: body.params.source,
        no_cache: body.params.no_cache,
    };
    mount_remote_profile(state.app_handle.clone(), params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.mount.completed",
        "remote" => remote_name
    ))))
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
    let message = unmount_remote(state.app_handle.clone(), body.mount_point, body.remote_name)
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
        source: body.params.source,
        no_cache: body.params.no_cache,
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
    let msg = stop_serve(state.app_handle.clone(), body.server_id, body.remote_name)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(msg)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameCacheProfileBody {
    pub remote_name: String,
    pub old_name: String,
    pub new_name: String,
}

pub async fn rename_mount_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RenameCacheProfileBody>,
) -> Result<Json<ApiResponse<usize>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let count = backend_manager
        .remote_cache
        .rename_profile_in_mounts(&body.remote_name, &body.old_name, &body.new_name)
        .await;
    Ok(Json(ApiResponse::success(count)))
}

pub async fn rename_serve_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RenameCacheProfileBody>,
) -> Result<Json<ApiResponse<usize>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let count = backend_manager
        .remote_cache
        .rename_profile_in_serves(&body.remote_name, &body.old_name, &body.new_name)
        .await;
    Ok(Json(ApiResponse::success(count)))
}
