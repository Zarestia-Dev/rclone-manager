//! Backup handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use tauri::Manager;

use crate::server::state::{ApiResponse, AppError, WebServerState};
use rcman::{JsonStorage, SettingsManager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettingsQuery {
    pub backup_dir: String,
    pub export_type: crate::utils::types::backup_types::ExportType,
    pub password: Option<String>,
    pub remote_name: Option<String>,
    pub user_note: Option<String>,
}

pub async fn backup_settings_handler(
    State(state): State<WebServerState>,
    Query(query): Query<BackupSettingsQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::backup::backup_manager::backup_settings;
    let manager: tauri::State<SettingsManager<JsonStorage>> = state.app_handle.state();
    let result = backup_settings(
        query.backup_dir,
        query.export_type,
        query.password,
        query.remote_name,
        query.user_note,
        manager,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct AnalyzeBackupFileQuery {
    pub path: String,
}

pub async fn analyze_backup_file_handler(
    State(state): State<WebServerState>,
    Query(query): Query<AnalyzeBackupFileQuery>,
) -> Result<Json<ApiResponse<crate::utils::types::backup_types::BackupAnalysis>>, AppError> {
    use crate::core::settings::backup::backup_manager::analyze_backup_file;
    use std::path::PathBuf;
    let path = PathBuf::from(query.path);
    let manager: tauri::State<SettingsManager<JsonStorage>> = state.app_handle.state();
    let analysis = analyze_backup_file(path, manager)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(analysis)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSettingsBody {
    pub backup_path: String,
    pub password: Option<String>,
}

pub async fn restore_settings_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RestoreSettingsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::backup::restore_manager::restore_settings;
    use std::path::PathBuf;
    let manager: tauri::State<SettingsManager<JsonStorage>> = state.app_handle.state();
    let backup_path = PathBuf::from(body.backup_path);
    let result = restore_settings(
        backup_path,
        body.password,
        manager,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

pub async fn get_export_categories_handler(
    State(state): State<WebServerState>,
) -> Result<
    Json<
        ApiResponse<Vec<crate::core::settings::backup::export_categories::ExportCategoryResponse>>,
    >,
    AppError,
> {
    use crate::core::settings::backup::export_categories::get_export_categories;
    let manager: tauri::State<SettingsManager<JsonStorage>> = state.app_handle.state();
    let categories = get_export_categories(manager);
    Ok(Json(ApiResponse::success(categories)))
}
