//! Security handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use rcman::JsonSettingsManager;
use serde::Deserialize;
use tauri::Manager;

use crate::server::state::{ApiResponse, AppError, WebServerState};

pub async fn has_stored_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::core::security::commands::has_stored_password;
    let credential_store = state.app_handle.state::<JsonSettingsManager>();
    let has_password = has_stored_password(credential_store)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(has_password)))
}

pub async fn is_config_encrypted_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::core::security::commands::is_config_encrypted;
    let is_encrypted = is_config_encrypted(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(is_encrypted)))
}

pub async fn remove_config_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::remove_config_password;
    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state.app_handle.state::<JsonSettingsManager>();
    remove_config_password(env_manager, credential_store)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Password removed successfully".to_string(),
    )))
}

#[derive(Deserialize)]
pub struct ValidateRclonePasswordQuery {
    pub password: String,
}

pub async fn validate_rclone_password_handler(
    State(state): State<WebServerState>,
    Query(query): Query<ValidateRclonePasswordQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::validate_rclone_password;
    validate_rclone_password(state.app_handle.clone(), query.password)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Password validation successful".to_string(),
    )))
}

#[derive(Deserialize)]
pub struct StoreConfigPasswordBody {
    pub password: String,
}

pub async fn store_config_password_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StoreConfigPasswordBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::store_config_password;
    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state.app_handle.state::<JsonSettingsManager>();
    store_config_password(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.password,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Password stored successfully".to_string(),
    )))
}

#[derive(Deserialize)]
pub struct UnencryptConfigBody {
    pub password: String,
}

pub async fn unencrypt_config_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UnencryptConfigBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::unencrypt_config;
    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let manager = state.app_handle.state::<JsonSettingsManager>();
    unencrypt_config(
        state.app_handle.clone(),
        env_manager,
        manager,
        body.password,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Configuration unencrypted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
pub struct EncryptConfigBody {
    pub password: String,
}

pub async fn encrypt_config_handler(
    State(state): State<WebServerState>,
    Json(body): Json<EncryptConfigBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::encrypt_config;
    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state.app_handle.state::<JsonSettingsManager>();
    encrypt_config(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.password,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Configuration encrypted successfully".to_string(),
    )))
}

pub async fn get_config_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::get_config_password;
    let credential_store = state.app_handle.state::<JsonSettingsManager>();
    let password = get_config_password(credential_store)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(password)))
}

#[derive(Deserialize)]
pub struct SetConfigPasswordEnvBody {
    pub password: String,
}

pub async fn set_config_password_env_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SetConfigPasswordEnvBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::set_config_password_env;
    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    set_config_password_env(state.app_handle.clone(), env_manager, body.password)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Config password environment variable set successfully".to_string(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeConfigPasswordBody {
    pub current_password: String,
    pub new_password: String,
}

pub async fn change_config_password_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ChangeConfigPasswordBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::change_config_password;
    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state.app_handle.state::<JsonSettingsManager>();
    change_config_password(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.current_password,
        body.new_password,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Config password changed successfully".to_string(),
    )))
}
