//! File operation handlers

use axum::http::header;
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Json},
};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::core::DiskUsage;
use crate::utils::types::remotes::ListOptions;

#[derive(Deserialize)]
pub struct FsInfoQuery {
    pub remote: String,
    pub path: Option<String>,
    pub origin: Option<String>,
    pub group: Option<String>,
}

pub async fn get_fs_info_handler(
    State(state): State<WebServerState>,
    Query(query): Query<FsInfoQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_fs_info;
    let info = get_fs_info(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.origin,
        query.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(info)))
}

#[derive(Deserialize)]
pub struct DiskUsageQuery {
    pub remote: String,
    pub path: Option<String>,
    pub origin: Option<String>,
    pub group: Option<String>,
}

pub async fn get_disk_usage_handler(
    State(state): State<WebServerState>,
    Query(query): Query<DiskUsageQuery>,
) -> Result<Json<ApiResponse<DiskUsage>>, AppError> {
    use crate::rclone::queries::get_disk_usage;
    let usage = get_disk_usage(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.origin,
        query.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(usage)))
}

pub async fn get_local_drives_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<crate::rclone::queries::filesystem::LocalDrive>>>, AppError> {
    use crate::RcloneState;
    use crate::rclone::queries::filesystem::get_local_drives;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let drives = get_local_drives(state.app_handle.clone(), rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(drives)))
}

#[derive(Deserialize)]
pub struct GetSizeQuery {
    pub remote: String,
    pub path: Option<String>,
    pub origin: Option<String>,
    pub group: Option<String>,
}

pub async fn get_size_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetSizeQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_size;
    let result = get_size(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.origin,
        query.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct GetStatQuery {
    pub remote: String,
    pub path: String,
    pub origin: Option<String>,
    pub group: Option<String>,
}

pub async fn get_stat_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetStatQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_stat;
    let result = get_stat(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.origin,
        query.group,
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
    pub origin: Option<String>,
    pub group: Option<String>,
}

pub async fn get_hashsum_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetHashsumQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_hashsum;
    let result = get_hashsum(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.hash_type,
        query.origin,
        query.group,
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
    let result = get_hashsum_file(
        state.app_handle.clone(),
        query.remote,
        query.path,
        query.hash_type,
        query.origin.clone(),
        query.group.clone(),
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
    pub origin: Option<String>,
    pub group: Option<String>,
}

pub async fn get_public_link_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetPublicLinkQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_public_link;
    let expire = query.expire.filter(|s| !s.is_empty());
    let options = Some(crate::rclone::queries::filesystem::PublicLinkParams {
        unlink: query.unlink,
        expire,
    });
    let result = get_public_link(
        state.app_handle.clone(),
        query.remote,
        query.path,
        options,
        query.origin,
        query.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirBody {
    pub remote: String,
    pub path: String,
    pub source: Option<String>,
    pub group: Option<String>,
}

pub async fn mkdir_handler(
    State(state): State<WebServerState>,
    Json(body): Json<MkdirBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::mkdir;
    mkdir(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.source,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupBody {
    pub remote: String,
    pub path: Option<String>,
    pub source: Option<String>,
    pub group: Option<String>,
}

pub async fn cleanup_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CleanupBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::cleanup;
    cleanup(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.source,
        body.group,
    )
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
    pub source: Option<String>,
    pub group: Option<String>,
}

pub async fn copy_url_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CopyUrlBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::copy_url;
    copy_url(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.url_to_copy,
        body.auto_filename,
        body.source,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileBody {
    pub remote: String,
    pub path: String,
    pub source: Option<String>,
    pub group: Option<String>,
}

pub async fn delete_file_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteFileBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::delete_file;
    delete_file(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.source,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeDirectoryBody {
    pub remote: String,
    pub path: String,
    pub source: Option<String>,
    pub group: Option<String>,
}

pub async fn purge_directory_handler(
    State(state): State<WebServerState>,
    Json(body): Json<PurgeDirectoryBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::purge_directory;
    purge_directory(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.source,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveEmptyDirsBody {
    pub remote: String,
    pub path: String,
    pub source: Option<String>,
    pub group: Option<String>,
}

pub async fn remove_empty_dirs_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RemoveEmptyDirsBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::remove_empty_dirs;
    remove_empty_dirs(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.source,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFileBody {
    pub src_remote: String,
    pub src_path: String,
    pub dst_remote: String,
    pub dst_path: String,
    pub source: Option<String>,
    pub no_cache: Option<bool>,
}

pub async fn copy_file_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CopyFileBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::filesystem::copy_file;
    let jobid = copy_file(
        state.app_handle.clone(),
        body.src_remote,
        body.src_path,
        body.dst_remote,
        body.dst_path,
        body.source,
        body.no_cache,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

pub async fn move_file_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CopyFileBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::filesystem::move_file;
    let jobid = move_file(
        state.app_handle.clone(),
        body.src_remote,
        body.src_path,
        body.dst_remote,
        body.dst_path,
        body.source,
        body.no_cache,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

pub async fn copy_dir_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CopyFileBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::filesystem::copy_dir;
    let jobid = copy_dir(
        state.app_handle.clone(),
        body.src_remote,
        body.src_path,
        body.dst_remote,
        body.dst_path,
        body.source,
        body.no_cache,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

pub async fn move_dir_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CopyFileBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::filesystem::move_dir;
    let jobid = move_dir(
        state.app_handle.clone(),
        body.src_remote,
        body.src_path,
        body.dst_remote,
        body.dst_path,
        body.source,
        body.no_cache,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBody {
    pub remote: String,
    pub src_path: String,
    pub dst_path: String,
    pub source: Option<String>,
    pub group: Option<String>,
}

pub async fn rename_file_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RenameBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::rename_file;
    rename_file(
        state.app_handle.clone(),
        body.remote,
        body.src_path,
        body.dst_path,
        body.source,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

pub async fn rename_dir_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RenameBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::rename_dir;
    rename_dir(
        state.app_handle.clone(),
        body.remote,
        body.src_path,
        body.dst_path,
        body.source,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
pub struct RemotePathsBody {
    pub remote: String,
    pub path: Option<String>,
    pub options: Option<serde_json::Value>,
    pub origin: Option<String>,
    pub group: Option<String>,
}

pub async fn get_remote_paths_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RemotePathsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_remote_paths;
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
        body.origin,
        body.group,
    )
    .await
    .map_err(anyhow::Error::msg)
    .map_err(AppError::BadRequest)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
pub struct StreamRemoteFileQuery {
    pub remote: String,
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_remote_file_handler(
    State(state): State<WebServerState>,
    Query(query): Query<StreamRemoteFileQuery>,
) -> Result<impl IntoResponse, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let rclone_state = state
        .app_handle
        .state::<crate::utils::types::core::RcloneState>();
    let client = &rclone_state.client;

    let response = backend
        .fetch_file_stream(client, &query.remote, &query.path)
        .await
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;

    if !response.status().is_success() {
        return Err(AppError::BadRequest(anyhow::Error::msg(format!(
            "Failed to fetch remote file ({}): {}/{}",
            response.status(),
            query.remote,
            query.path
        ))));
    }

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let body = axum::body::Body::from_stream(response.bytes_stream());

    let mut builder =
        axum::response::Response::builder().header(header::CONTENT_TYPE, content_type);

    if query.download.unwrap_or(false) {
        let filename = query.path.split('/').last().unwrap_or("file").replace(
            |c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_',
            "_",
        );
        builder = builder.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        );
    }

    Ok(builder
        .body(body)
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))?)
}

#[derive(Deserialize)]
pub struct ConvertFileSrcQuery {
    pub path: String,
    pub download: Option<bool>,
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

    let mut builder =
        axum::response::Response::builder().header(header::CONTENT_TYPE, mime_type.as_ref());

    if query.download.unwrap_or(false) {
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .replace(
                |c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_',
                "_",
            );
        builder = builder.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        );
    }

    builder
        .body(body)
        .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e.to_string())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileBody {
    pub remote: String,
    pub path: String,
    pub filename: String,
    pub content: String,
}

pub async fn upload_file_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UploadFileBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::filesystem::upload_file;
    let result = upload_file(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.filename,
        body.content,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileBytesBody {
    pub remote: String,
    pub path: String,
    pub filename: String,
    pub content: Vec<u8>,
}

pub async fn upload_file_bytes_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UploadFileBytesBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::filesystem::upload_file_bytes;
    let result = upload_file_bytes(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.filename,
        body.content,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct AudioCoverQuery {
    pub remote: String,
    pub path: String,
    pub is_local: bool,
}

pub async fn get_audio_cover_handler(
    State(state): State<WebServerState>,
    Query(query): Query<AudioCoverQuery>,
) -> Result<Json<ApiResponse<Option<String>>>, AppError> {
    use crate::utils::app::audio::get_audio_cover;
    let cover = get_audio_cover(
        query.remote,
        query.path,
        query.is_local,
        state.app_handle.clone(),
    )
    .await
    .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
    Ok(Json(ApiResponse::success(cover)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadLocalDropFilesBody {
    pub remote: String,
    pub path: String,
    pub files: Vec<crate::rclone::commands::filesystem::LocalDropUploadFile>,
    pub source: Option<String>,
}

pub async fn upload_local_drop_files_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UploadLocalDropFilesBody>,
) -> Result<Json<ApiResponse<crate::rclone::commands::filesystem::LocalDropUploadResult>>, AppError>
{
    use crate::rclone::commands::filesystem::upload_local_drop_files;
    let result = upload_local_drop_files(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.files,
        body.source,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadLocalDropPathsBody {
    pub remote: String,
    pub path: String,
    pub local_paths: Vec<String>,
    pub source: Option<String>,
}

pub async fn upload_local_drop_paths_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UploadLocalDropPathsBody>,
) -> Result<Json<ApiResponse<crate::rclone::commands::filesystem::LocalDropUploadResult>>, AppError>
{
    use crate::rclone::commands::filesystem::upload_local_drop_paths;
    let result = upload_local_drop_paths(
        state.app_handle.clone(),
        body.remote,
        body.path,
        body.local_paths,
        body.source,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDropUploadEntryDTO {
    pub relative_path: String,
    pub filename: String,
    pub size: usize,
    pub content: Option<Vec<u8>>,
    pub local_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadLocalDropEntriesBody {
    pub remote: String,
    pub path: String,
    pub entries: Vec<LocalDropUploadEntryDTO>,
    pub source: Option<String>,
}

pub async fn upload_local_drop_entries_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UploadLocalDropEntriesBody>,
) -> Result<Json<ApiResponse<crate::rclone::commands::filesystem::LocalDropUploadResult>>, AppError>
{
    use crate::rclone::commands::filesystem::{
        LocalDropUploadEntry, LocalDropUploadEntrySource, upload_local_drop_entries,
    };
    use std::path::PathBuf;

    let entries: Vec<LocalDropUploadEntry> = body
        .entries
        .into_iter()
        .map(|dto| {
            let source = if let Some(content) = dto.content {
                LocalDropUploadEntrySource::Bytes(content)
            } else if let Some(local_path) = dto.local_path {
                LocalDropUploadEntrySource::Path(PathBuf::from(local_path))
            } else {
                // Default to empty bytes if nothing provided
                LocalDropUploadEntrySource::Bytes(Vec::new())
            };

            LocalDropUploadEntry {
                relative_path: dto.relative_path,
                filename: dto.filename,
                size: dto.size,
                source,
            }
        })
        .collect();

    let result = upload_local_drop_entries(
        &state.app_handle,
        body.remote,
        body.path,
        entries,
        body.source,
    )
    .await
    .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(result)))
}
