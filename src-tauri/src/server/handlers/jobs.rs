//! Job-related handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use tauri::Manager;

use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::remotes::ProfileParams;

pub async fn get_jobs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let jobs = backend_manager.job_cache.get_jobs().await;
    let json_jobs = serde_json::to_value(jobs).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_jobs)))
}

pub async fn get_active_jobs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let active_jobs = backend_manager.job_cache.get_active_jobs().await;
    let json_active_jobs = serde_json::to_value(active_jobs).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_active_jobs)))
}

#[derive(Deserialize)]
pub struct JobsBySourceQuery {
    pub source: String,
}

pub async fn get_jobs_by_source_handler(
    State(state): State<WebServerState>,
    Query(query): Query<JobsBySourceQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let jobs = backend_manager
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
    State(state): State<WebServerState>,
    Query(query): Query<JobStatusQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let opt = backend_manager.job_cache.get_job(query.jobid).await;
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
    stop_job(
        state.app_handle.clone(),
        scheduled_cache,
        body.jobid,
        body.remote_name,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.job.stopped"
    ))))
}

#[derive(Deserialize)]
pub struct DeleteJobBody {
    pub jobid: u64,
}

pub async fn delete_job_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteJobBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    backend_manager
        .job_cache
        .delete_job(body.jobid, Some(&state.app_handle))
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.job.deleted"
    ))))
}

#[derive(Deserialize)]
pub struct ProfileParamsBody {
    pub params: ProfileParamsInner,
}

#[derive(Deserialize)]
pub struct ProfileParamsInner {
    pub remote_name: String,
    pub profile_name: String,
    pub source: Option<String>,
    pub no_cache: Option<bool>,
}

pub async fn start_sync_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_sync_profile;
    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
        source: body.params.source,
        no_cache: body.params.no_cache,
    };
    let jobid = start_sync_profile(state.app_handle.clone(), params)
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
        source: body.params.source,
        no_cache: body.params.no_cache,
    };
    let jobid = start_copy_profile(state.app_handle.clone(), params)
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
        source: body.params.source,
        no_cache: body.params.no_cache,
    };
    let jobid = start_move_profile(state.app_handle.clone(), params)
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
        source: body.params.source,
        no_cache: body.params.no_cache,
    };
    let jobid = start_bisync_profile(state.app_handle.clone(), params)
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
    State(state): State<WebServerState>,
    Json(body): Json<RenameProfileBody>,
) -> Result<Json<ApiResponse<usize>>, AppError> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = state.app_handle.state::<BackendManager>();
    let count = backend_manager
        .job_cache
        .rename_profile(
            &body.remote_name,
            &body.old_name,
            &body.new_name,
            Some(&state.app_handle),
        )
        .await;
    Ok(Json(ApiResponse::success(count)))
}

#[derive(Deserialize)]
pub struct StopJobsGroupBody {
    pub group: String,
}

pub async fn stop_jobs_by_group_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StopJobsGroupBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::job::stop_jobs_by_group;
    stop_jobs_by_group(state.app_handle.clone(), body.group)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.job.groupStopped"
    ))))
}
