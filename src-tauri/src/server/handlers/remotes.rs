//! Remote-related handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use log::info;
use serde::Deserialize;
use tauri::Manager;

use crate::core::scheduler::engine::CronScheduler;
use crate::rclone::commands::remote::create_remote;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::server::state::{ApiResponse, AppError, WebServerState};

pub async fn get_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    use crate::rclone::state::cache::get_cached_remotes;
    let remotes = get_cached_remotes(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    info!("Fetched remotes: {:?}", remotes);
    Ok(Json(ApiResponse::success(remotes)))
}

#[derive(Deserialize)]
pub struct RemoteNameQuery {
    pub name: String,
}

pub async fn get_remote_config_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteNameQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_remote_config;
    let config = get_remote_config(state.app_handle.clone(), query.name)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(config)))
}

pub async fn get_remote_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_remote_types;
    let types = get_remote_types(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_types = serde_json::to_value(types)?;
    Ok(Json(ApiResponse::success(json_types)))
}

pub async fn get_cached_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    use crate::rclone::state::cache::get_cached_remotes;
    let remotes = get_cached_remotes(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    info!("Fetched cached remotes: {:?}", remotes);
    Ok(Json(ApiResponse::success(remotes)))
}

pub async fn get_oauth_supported_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_oauth_supported_remotes;
    let remotes = get_oauth_supported_remotes(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    let json_remotes = serde_json::to_value(remotes).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_remotes)))
}

#[derive(Deserialize)]
pub struct CreateRemoteBody {
    pub name: String,
    pub parameters: serde_json::Value,
}

pub async fn create_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CreateRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    // Convert serde_json::Value to HashMap for the function signature
    let parameters: std::collections::HashMap<String, serde_json::Value> = body
        .parameters
        .as_object()
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    create_remote(state.app_handle.clone(), body.name, parameters)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.remote.created"
    ))))
}

#[derive(Deserialize)]
pub struct CreateRemoteInteractiveBody {
    pub name: String,
    #[serde(rename = "rclone_type")]
    pub rclone_type: Option<String>,
    #[serde(rename = "rcloneType")]
    pub rclone_type_alt: Option<String>,
    pub parameters: Option<serde_json::Value>,
    pub opt: Option<serde_json::Value>,
}

pub async fn create_remote_interactive_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CreateRemoteInteractiveBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::commands::remote::create_remote_interactive;
    let rclone_type = body
        .rclone_type
        .clone()
        .or(body.rclone_type_alt.clone())
        .unwrap_or_default();
    // Convert serde_json::Value to Option<HashMap<String, Value>> for the function signature
    let parameters: Option<std::collections::HashMap<String, serde_json::Value>> =
        body.parameters.as_ref().and_then(|p| {
            p.as_object()
                .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        });
    let value = create_remote_interactive(
        state.app_handle.clone(),
        body.name,
        rclone_type,
        parameters,
        body.opt,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct ContinueCreateRemoteInteractiveBody {
    pub name: String,
    #[serde(rename = "state_token")]
    pub state_token: Option<String>,
    #[serde(rename = "stateToken")]
    pub state_token_alt: Option<String>,
    pub result: serde_json::Value,
    pub parameters: Option<serde_json::Value>,
    pub opt: Option<serde_json::Value>,
}

pub async fn continue_create_remote_interactive_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ContinueCreateRemoteInteractiveBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::commands::remote::continue_create_remote_interactive;
    let state_token = body
        .state_token
        .clone()
        .or(body.state_token_alt.clone())
        .unwrap_or_default();
    // Convert serde_json::Value to Option<HashMap<String, Value>> for the function signature
    let parameters: Option<std::collections::HashMap<String, serde_json::Value>> =
        body.parameters.as_ref().and_then(|p| {
            p.as_object()
                .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        });
    let value = continue_create_remote_interactive(
        state.app_handle.clone(),
        body.name,
        state_token,
        body.result,
        parameters,
        body.opt,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

pub async fn quit_rclone_oauth_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::system::quit_rclone_oauth;
    quit_rclone_oauth(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.system.oauthQuit"
    ))))
}

#[derive(Deserialize)]
pub struct DeleteRemoteBody {
    pub name: String,
}

pub async fn delete_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::remote::delete_remote;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();
    delete_remote(state.app_handle.clone(), body.name, cache, scheduler)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.remote.deleted"
    ))))
}

#[derive(Deserialize)]
pub struct UpdateRemoteBody {
    pub name: String,
    pub parameters: std::collections::HashMap<String, serde_json::Value>,
}

pub async fn update_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UpdateRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::remote::update_remote;
    update_remote(state.app_handle.clone(), body.name, body.parameters)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.remote.updated"
    ))))
}
