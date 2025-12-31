//! Job-related handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use tauri::Manager;

use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::all_types::{ProfileParams, RcloneState};

pub async fn get_jobs_handler(
    State(_): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    let jobs = BACKEND_MANAGER.job_cache.get_jobs().await;
    let json_jobs = serde_json::to_value(jobs).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_jobs)))
}

pub async fn get_active_jobs_handler(
    State(_): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    let active_jobs = BACKEND_MANAGER.job_cache.get_active_jobs().await;
    let json_active_jobs = serde_json::to_value(active_jobs).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_active_jobs)))
}

#[derive(Deserialize)]
pub struct JobsBySourceQuery {
    pub source: String,
}

pub async fn get_jobs_by_source_handler(
    State(_): State<WebServerState>,
    Query(query): Query<JobsBySourceQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    let jobs = BACKEND_MANAGER
        .job_cache
        .get_jobs_by_source(&query.source)
        .await;
    let json_jobs = serde_json::to_value(jobs).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_jobs)))
}

#[derive(Deserialize)]
pub struct JobStatusQuery {
    pub jobid: u64,
}

pub async fn get_job_status_handler(
    State(_): State<WebServerState>,
    Query(query): Query<JobStatusQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    let opt = BACKEND_MANAGER.job_cache.get_job(query.jobid).await;
    let json = match opt {
        Some(j) => serde_json::to_value(j).map_err(anyhow::Error::msg)?,
        None => serde_json::Value::Null,
    };
    Ok(Json(ApiResponse::success(json)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopJobBody {
    pub jobid: u64,
    pub remote_name: String,
}

pub async fn stop_job_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StopJobBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::job::stop_job;
    use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
    let scheduled_cache = state.app_handle.state::<ScheduledTasksCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    stop_job(
        state.app_handle.clone(),
        scheduled_cache,
        body.jobid,
        body.remote_name,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Job stopped successfully".to_string(),
    )))
}

#[derive(Deserialize)]
pub struct DeleteJobBody {
    pub jobid: u64,
}

pub async fn delete_job_handler(
    State(_): State<WebServerState>,
    Json(body): Json<DeleteJobBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    BACKEND_MANAGER
        .job_cache
        .delete_job(body.jobid)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Job deleted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
pub struct ProfileParamsBody {
    pub params: ProfileParamsInner,
}

#[derive(Deserialize)]
pub struct ProfileParamsInner {
    pub remote_name: String,
    pub profile_name: String,
}

pub async fn start_sync_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_sync_profile;
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };
    // Removed job_cache
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let jobid = start_sync_profile(state.app_handle.clone(), rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

pub async fn start_copy_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_copy_profile;
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let jobid = start_copy_profile(state.app_handle.clone(), rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

pub async fn start_move_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_move_profile;
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let jobid = start_move_profile(state.app_handle.clone(), rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

pub async fn start_bisync_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_bisync_profile;
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let jobid = start_bisync_profile(state.app_handle.clone(), rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProfileBody {
    pub remote_name: String,
    pub old_name: String,
    pub new_name: String,
}

pub async fn rename_job_profile_handler(
    State(_): State<WebServerState>,
    Json(body): Json<RenameProfileBody>,
) -> Result<Json<ApiResponse<usize>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    let count = BACKEND_MANAGER
        .job_cache
        .rename_profile(&body.remote_name, &body.old_name, &body.new_name)
        .await;
    Ok(Json(ApiResponse::success(count)))
}
