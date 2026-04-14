//! Backend handlers (add, update, remove, switch, test, list)

use axum::{extract::State, response::Json};
use serde::Deserialize;
use tauri::Manager;

use crate::core::scheduler::engine::CronScheduler;
use crate::rclone::backend::types::BackendInfo;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::server::state::{ApiResponse, AppError, WebServerState};

pub async fn list_backends_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<BackendInfo>>>, AppError> {
    use crate::rclone::commands::backend::list_backends;
    let backends = list_backends(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(backends)))
}

pub async fn get_backend_schema_handler()
-> Result<Json<ApiResponse<std::collections::HashMap<String, rcman::SettingMetadata>>>, AppError> {
    use crate::rclone::commands::backend::get_backend_schema;
    let schema = get_backend_schema().await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(schema)))
}

pub async fn get_active_backend_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::backend::get_active_backend;
    let active = get_active_backend(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(active)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchBackendBody {
    pub name: String,
}

pub async fn switch_backend_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SwitchBackendBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::backend::switch_backend;
    switch_backend(state.app_handle.clone(), body.name.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.backend.switched",
        "name" => body.name
    ))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBackendBody {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub is_local: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub config_password: Option<String>,
    pub config_path: Option<String>,
    pub oauth_port: Option<u16>,
    pub oauth_host: Option<String>,
    pub copy_backend_from: Option<String>,
    pub copy_remotes_from: Option<String>,
}

#[derive(Deserialize)]
pub struct AddBackendRequest {
    pub params: AddBackendBody,
}

pub async fn add_backend_handler(
    State(state): State<WebServerState>,
    Json(body): Json<AddBackendRequest>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let body = body.params;
    use crate::rclone::commands::backend::add_backend;
    add_backend(
        state.app_handle.clone(),
        crate::rclone::commands::backend::AddBackendParams {
            name: body.name.clone(),
            host: body.host,
            port: body.port,
            is_local: body.is_local,
            username: body.username,
            password: body.password,
            config_password: body.config_password,
            config_path: body.config_path,
            oauth_port: body.oauth_port,
            oauth_host: body.oauth_host,
            copy_backend_from: body.copy_backend_from,
            copy_remotes_from: body.copy_remotes_from,
        },
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.backend.added",
        "name" => body.name
    ))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBackendBody {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub config_password: Option<String>,
    pub config_path: Option<String>,
    pub oauth_port: Option<u16>,
    pub oauth_host: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateBackendRequest {
    pub params: UpdateBackendBody,
}

pub async fn update_backend_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UpdateBackendRequest>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let body = body.params;
    use crate::rclone::commands::backend::update_backend;
    update_backend(
        state.app_handle.clone(),
        crate::rclone::commands::backend::UpdateBackendParams {
            name: body.name.clone(),
            host: body.host,
            port: body.port,
            username: body.username,
            password: body.password,
            config_password: body.config_password,
            config_path: body.config_path,
            oauth_port: body.oauth_port,
            oauth_host: body.oauth_host,
        },
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.backend.updated",
        "name" => body.name
    ))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveBackendBody {
    pub name: String,
}

pub async fn remove_backend_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RemoveBackendBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::backend::remove_backend;
    let scheduler = state.app_handle.state::<CronScheduler>();
    let task_cache = state.app_handle.state::<ScheduledTasksCache>();
    remove_backend(
        state.app_handle.clone(),
        body.name.clone(),
        scheduler,
        task_cache,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.backend.removed",
        "name" => body.name
    ))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestBackendConnectionBody {
    pub name: String,
}

pub async fn test_backend_connection_handler(
    State(state): State<WebServerState>,
    Json(body): Json<TestBackendConnectionBody>,
) -> Result<Json<ApiResponse<crate::rclone::commands::backend::TestConnectionResult>>, AppError> {
    use crate::rclone::commands::backend::test_backend_connection;
    let result = test_backend_connection(state.app_handle.clone(), body.name)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

pub async fn get_backend_profiles_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    use crate::rclone::commands::backend::get_backend_profiles;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    let profiles = get_backend_profiles(manager)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(profiles)))
}
