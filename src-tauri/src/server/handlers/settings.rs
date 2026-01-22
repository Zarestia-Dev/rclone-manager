//! Settings handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use tauri::Manager;

use crate::core::scheduler::engine::CronScheduler;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::server::state::{ApiResponse, AppError, WebServerState};

pub async fn get_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_settings;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    let settings = get_settings(manager).await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(settings)))
}

pub async fn load_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::core::settings::operations::core::load_settings;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    let settings = load_settings(manager).await.map_err(anyhow::Error::msg)?;
    let json_settings = serde_json::to_value(settings)?;
    Ok(Json(ApiResponse::success(json_settings)))
}

#[derive(Deserialize)]
pub struct SaveSettingBody {
    pub category: String,
    pub key: String,
    pub value: serde_json::Value,
}

pub async fn save_setting_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveSettingBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::operations::core::save_setting;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    save_setting(
        body.category,
        body.key,
        body.value,
        manager,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.settings.saved"
    ))))
}

#[derive(Deserialize)]
pub struct ResetSettingBody {
    pub category: String,
    pub key: String,
}

pub async fn reset_setting_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ResetSettingBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::core::settings::operations::core::reset_setting;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    let default_value = reset_setting(body.category, body.key, manager, state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(default_value)))
}

pub async fn reset_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::operations::core::reset_settings;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    reset_settings(manager, state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.settings.reset"
    ))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRemoteSettingsBody {
    pub remote_name: String,
    pub settings: serde_json::Value,
}

pub async fn save_remote_settings_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveRemoteSettingsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::remote::manager::save_remote_settings;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    let task_cache = state.app_handle.state::<ScheduledTasksCache>();
    let cron_cache = state.app_handle.state::<CronScheduler>();
    save_remote_settings(
        body.remote_name,
        body.settings,
        manager,
        task_cache,
        cron_cache,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.settings.remoteSaved"
    ))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRemoteSettingsBody {
    pub remote_name: String,
}

pub async fn delete_remote_settings_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteRemoteSettingsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::remote::manager::delete_remote_settings;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    delete_remote_settings(body.remote_name, manager, state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.settings.remoteDeleted"
    ))))
}

pub async fn check_links_handler(
    State(_state): State<WebServerState>,
    Query(params): Query<Vec<(String, String)>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::utils::io::network::check_links;
    let links: Vec<String> = params
        .iter()
        .filter(|(key, _)| key == "links")
        .map(|(_, value)| value.clone())
        .collect();
    if links.is_empty() {
        return Err(AppError::BadRequest(anyhow::anyhow!("No links provided")));
    }
    let max_retries = params
        .iter()
        .find(|(k, _)| k == "maxRetries")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(2);
    let retry_delay_secs = params
        .iter()
        .find(|(k, _)| k == "retryDelaySecs")
        .and_then(|(_, v)| v.parse::<u64>().ok())
        .unwrap_or(3);
    let result = check_links(links, max_retries, retry_delay_secs)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_result = serde_json::to_value(result).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_result)))
}

#[derive(Deserialize)]
pub struct SaveRCloneBackendOptionsBody {
    pub options: serde_json::Value,
}

pub async fn save_rclone_backend_options_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveRCloneBackendOptionsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::save_rclone_backend_options;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    save_rclone_backend_options(manager, body.options)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.settings.optionsSaved"
    ))))
}

pub async fn reset_rclone_backend_options_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::reset_rclone_backend_options;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    reset_rclone_backend_options(state.app_handle.clone(), manager)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.settings.optionsReset"
    ))))
}

pub async fn get_rclone_backend_store_path_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::get_rclone_backend_store_path;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    let path = get_rclone_backend_store_path(manager)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(path)))
}

#[derive(Deserialize)]
pub struct SaveRCloneBackendOptionBody {
    pub block: String,
    pub option: String,
    pub value: serde_json::Value,
}

pub async fn save_rclone_backend_option_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveRCloneBackendOptionBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::save_rclone_backend_option;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    save_rclone_backend_option(manager, body.block, body.option, body.value)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "RClone backend option saved successfully".to_string(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRCloneOptionBody {
    pub block_name: String,
    pub option_name: String,
    pub value: serde_json::Value,
}

pub async fn set_rclone_option_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SetRCloneOptionBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::RcloneState;
    use crate::rclone::queries::flags::set_rclone_option;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let result = set_rclone_option(rclone_state, body.block_name, body.option_name, body.value)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct RemoveRCloneBackendOptionBody {
    pub block: String,
    pub option: String,
}

pub async fn remove_rclone_backend_option_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RemoveRCloneBackendOptionBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::remove_rclone_backend_option;
    let manager: tauri::State<crate::core::settings::AppSettingsManager> = state.app_handle.state();
    remove_rclone_backend_option(manager, body.block, body.option)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "RClone backend option removed successfully".to_string(),
    )))
}
