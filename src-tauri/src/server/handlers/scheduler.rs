//! Scheduler handlers

use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use tauri::Manager;

use crate::core::scheduler::commands::validate_cron;
use crate::core::scheduler::engine::CronScheduler;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::server::state::{ApiResponse, AppError, WebServerState};
use crate::utils::types::scheduled_task::CronValidationResponse;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateCronQuery {
    pub cron_expression: String,
}

pub async fn validate_cron_handler(
    State(_state): State<WebServerState>,
    Query(query): Query<ValidateCronQuery>,
) -> Result<Json<ApiResponse<CronValidationResponse>>, AppError> {
    let result = validate_cron(query.cron_expression)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct ReloadScheduledTasksBody {
    pub remote_configs: serde_json::Value,
}

pub async fn reload_scheduled_tasks_from_configs_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ReloadScheduledTasksBody>,
) -> Result<Json<ApiResponse<usize>>, AppError> {
    use crate::rclone::state::scheduled_tasks::reload_scheduled_tasks_from_configs;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();
    let count = reload_scheduled_tasks_from_configs(cache, scheduler, body.remote_configs)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(count)))
}

pub async fn get_scheduled_tasks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::scheduled_tasks::get_scheduled_tasks;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let tasks = get_scheduled_tasks(cache)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_tasks = serde_json::to_value(tasks).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_tasks)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleScheduledTaskBody {
    pub task_id: String,
}

pub async fn toggle_scheduled_task_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ToggleScheduledTaskBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::core::scheduler::commands::toggle_scheduled_task;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();
    let task = toggle_scheduled_task(cache, scheduler, body.task_id)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_task = serde_json::to_value(task).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_task)))
}

pub async fn get_scheduled_tasks_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::scheduled_tasks::get_scheduled_tasks_stats;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let stats = get_scheduled_tasks_stats(cache)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_stats = serde_json::to_value(stats).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_stats)))
}

pub async fn reload_scheduled_tasks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::scheduler::commands::reload_scheduled_tasks;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();
    reload_scheduled_tasks(cache, scheduler)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.scheduler.reloaded"
    ))))
}

pub async fn clear_all_scheduled_tasks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::scheduler::commands::clear_all_scheduled_tasks;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();
    clear_all_scheduled_tasks(cache, scheduler)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.scheduler.cleared"
    ))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetScheduledTaskQuery {
    pub task_id: String,
}

pub async fn get_scheduled_task_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetScheduledTaskQuery>,
) -> Result<Json<ApiResponse<Option<serde_json::Value>>>, AppError> {
    use crate::rclone::state::scheduled_tasks::get_scheduled_task;
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let task = get_scheduled_task(cache, query.task_id)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_task = task.map(|t| serde_json::to_value(t)).transpose()?;
    Ok(Json(ApiResponse::success(json_task)))
}
