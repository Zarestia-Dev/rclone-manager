//! File operation handlers

use axum::http::header;
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Json},
};
use serde::Deserialize;
use tauri::Manager;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::RcloneState;
use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::core::DiskUsage;
use crate::utils::types::remotes::ListOptions;

#[derive(Deserialize)]
pub struct FsInfoQuery {
    pub remote: String,
    pub path: Option<String>,
}

pub async fn get_fs_info_handler(
    State(state): State<WebServerState>,
    Query(query): Query<FsInfoQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_fs_info;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let info = get_fs_info(
        state.app_handle.clone(),
        query.remote,
        query.path,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(info)))
}

#[derive(Deserialize)]
pub struct DiskUsageQuery {
    pub remote: String,
    pub path: Option<String>,
}

pub async fn get_disk_usage_handler(
    State(state): State<WebServerState>,
    Query(query): Query<DiskUsageQuery>,
) -> Result<Json<ApiResponse<DiskUsage>>, AppError> {
    use crate::rclone::queries::get_disk_usage;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let usage = get_disk_usage(
        state.app_handle.clone(),
        query.remote,
        query.path,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(usage)))
}

pub async fn get_local_drives_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<crate::rclone::queries::filesystem::LocalDrive>>>, AppError> {
    use crate::rclone::queries::filesystem::get_local_drives;
    let drives = get_local_drives().await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(drives)))
}

#[derive(Deserialize)]
pub struct GetSizeQuery {
    pub remote: String,
    pub path: Option<String>,
}

pub async fn get_size_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetSizeQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_size;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let result = get_size(
        state.app_handle.clone(),
        query.remote,
        query.path,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct GetStatQuery {
    pub remote: String,
    pub path: String,
}

pub async fn get_stat_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetStatQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_stat;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let result = get_stat(
        state.app_handle.clone(),
        query.remote,
        query.path,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHashsumQuery {
    pub remote: String,
    pub path: String,
    pub hash_type: String,
}

pub async fn get_hashsum_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetHashsumQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_hashsum;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let result = get_hashsum(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.hash_type,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

pub async fn get_hashsum_file_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetHashsumQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_hashsum_file;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let result = get_hashsum_file(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.hash_type,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct GetPublicLinkQuery {
    pub remote: String,
    pub path: String,
    pub unlink: Option<bool>,
    pub expire: Option<String>,
}

pub async fn get_public_link_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetPublicLinkQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_public_link;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let expire = query.expire.filter(|s| !s.is_empty());
    let result = get_public_link(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.unlink,
        expire,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct MkdirBody {
    pub remote: String,
    pub path: String,
}

pub async fn mkdir_handler(
    State(state): State<WebServerState>,
    Json(body): Json<MkdirBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::mkdir;
    mkdir(state.app_handle.clone(), body.remote, body.path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
pub struct CleanupBody {
    pub remote: String,
    pub path: Option<String>,
}

pub async fn cleanup_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CleanupBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::cleanup;
    cleanup(state.app_handle.clone(), body.remote, body.path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyUrlBody {
    pub remote: String,
    pub path: String,
    pub url_to_copy: String,
    pub auto_filename: bool,
}

pub async fn copy_url_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CopyUrlBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::filesystem::copy_url;
    let jobid = copy_url(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.url_to_copy,
        body.auto_filename,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

#[derive(Deserialize)]
pub struct RemotePathsBody {
    pub remote: String,
    pub path: Option<String>,
    pub options: Option<serde_json::Value>,
}

pub async fn get_remote_paths_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RemotePathsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_remote_paths;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let options = body.options.map(|v| {
        serde_json::from_value::<ListOptions>(v).unwrap_or(ListOptions {
            extra: std::collections::HashMap::new(),
        })
    });
    let value = get_remote_paths(
        state.app_handle.clone(),
        body.remote,
        body.path,
        options,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)
    .map_err(AppError::BadRequest)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct ConvertFileSrcQuery {
    pub path: String,
}

pub async fn stream_file_handler(
    Query(query): Query<ConvertFileSrcQuery>,
) -> Result<impl IntoResponse, AppError> {
    let path = std::path::PathBuf::from(&query.path);
    if !path.exists() {
        return Err(AppError::NotFound(
            "backendErrors.filesystem.notFound".to_string(),
        ));
    }

    let file = File::open(&path).await.map_err(anyhow::Error::msg)?;
    let stream = ReaderStream::new(file);
    let body = axum::body::Body::from_stream(stream);

    let mime_type = mime_guess::from_path(&path).first_or_octet_stream();

    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, mime_type.as_ref())
        .body(body)
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
}
