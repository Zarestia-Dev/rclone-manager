//! System handlers (stats, info, updates, logs, SSE, etc.)

use axum::{
    extract::{Query, State},
    response::{Json, Sse, sse::Event},
};
use futures::stream::Stream;
use log::info;
use serde::Deserialize;
use std::{collections::HashMap, convert::Infallible};
use tauri::Manager;
use tokio::sync::broadcast;

use crate::core::lifecycle::shutdown::handle_shutdown;
use crate::server::state::{ApiResponse, AppError, WebServerState};

#[cfg(feature = "updater")]
use crate::utils::app::updater::app_updates::{
    DownloadState, PendingUpdate, fetch_update, get_download_status, install_update,
};

pub async fn get_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_core_stats;
    let rclone_state = state.app_handle.state::<RcloneState>();
    let stats = get_core_stats(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(stats)))
}

pub async fn get_core_stats_filtered_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::stats::get_core_stats_filtered;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let jobid = params.get("jobid").and_then(|s| s.parse::<u64>().ok());
    let group = params.get("group").cloned();
    let value = get_core_stats_filtered(rclone_state, jobid, group)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

pub async fn get_completed_transfers_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::stats::get_completed_transfers;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let group = params.get("group").cloned();
    let value = get_completed_transfers(rclone_state, group)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

pub async fn get_memory_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_memory_stats;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let stats = get_memory_stats(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_stats = serde_json::to_value(stats)?;
    Ok(Json(ApiResponse::success(json_stats)))
}

pub async fn get_bandwidth_limit_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<BandwidthLimitResponse>>, AppError> {
    use crate::rclone::queries::get_bandwidth_limit;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let limit = get_bandwidth_limit(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(limit)))
}

pub async fn get_rclone_info_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_rclone_info;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let info = get_rclone_info(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_info = serde_json::to_value(info)?;
    Ok(Json(ApiResponse::success(json_info)))
}

pub async fn get_rclone_pid_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_rclone_pid;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let pid = get_rclone_pid(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_pid = serde_json::to_value(pid)?;
    Ok(Json(ApiResponse::success(json_pid)))
}

pub async fn get_rclone_rc_url_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::backend::BACKEND_MANAGER;
    let backend_manager = &BACKEND_MANAGER;
    let backend = backend_manager.get_active().await;
    let url = backend.api_url();
    Ok(Json(ApiResponse::success(url)))
}

#[derive(Deserialize)]
pub struct KillProcessByPidQuery {
    pub pid: u32,
}

pub async fn kill_process_by_pid_handler(
    State(_state): State<WebServerState>,
    Query(query): Query<KillProcessByPidQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::utils::process::process_manager::kill_process_by_pid;
    kill_process_by_pid(query.pid).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.system.processKilled",
        "pid" => query.pid
    ))))
}

#[derive(Deserialize)]
pub struct CheckRcloneAvailableQuery {
    pub path: Option<String>,
}

pub async fn check_rclone_available_handler(
    State(state): State<WebServerState>,
    Query(query): Query<CheckRcloneAvailableQuery>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::core::check_binaries::check_rclone_available;
    let path = query.path.as_deref().unwrap_or("");
    let available = check_rclone_available(state.app_handle.clone(), path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(available)))
}

pub async fn check_mount_plugin_installed_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::utils::rclone::mount::check_mount_plugin_installed;
    let installed = check_mount_plugin_installed();
    Ok(Json(ApiResponse::success(installed)))
}

pub async fn is_network_metered_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::utils::io::network::is_network_metered;
    let metered = is_network_metered();
    Ok(Json(ApiResponse::success(metered)))
}

#[derive(Deserialize)]
pub struct ProvisionRcloneQuery {
    pub path: Option<String>,
}

pub async fn provision_rclone_handler(
    State(state): State<WebServerState>,
    Query(query): Query<ProvisionRcloneQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::utils::rclone::provision::provision_rclone;
    let path = query.path.filter(|p| p != "null");
    let message = provision_rclone(state.app_handle.clone(), path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(message)))
}

#[derive(Deserialize)]
pub struct CheckRcloneUpdateQuery {
    pub channel: Option<String>,
}

pub async fn check_rclone_update_handler(
    State(state): State<WebServerState>,
    Query(query): Query<CheckRcloneUpdateQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::utils::rclone::updater::check_rclone_update;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let result = check_rclone_update(state.app_handle.clone(), rclone_state, query.channel)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
pub struct UpdateRcloneQuery {
    pub channel: Option<String>,
}

pub async fn update_rclone_handler(
    State(state): State<WebServerState>,
    Query(query): Query<UpdateRcloneQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::utils::rclone::updater::update_rclone;
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let result = update_rclone(rclone_state, state.app_handle.clone(), query.channel)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

pub async fn get_configs_handler() -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_configs;
    let configs = get_configs().await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(configs)))
}

pub async fn handle_shutdown_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let app_handle = state.app_handle.clone();
    tokio::spawn(async move {
        handle_shutdown(app_handle).await;
    });
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.system.shutdownInitiated"
    ))))
}

pub async fn force_check_serves_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::state::watcher::force_check_serves;
    force_check_serves(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.system.servesChecked"
    ))))
}

// Logs
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLogsQuery {
    pub remote_name: Option<String>,
}

pub async fn get_remote_logs_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteLogsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::log::get_remote_logs;
    let log_cache = state.app_handle.state::<LogCache>();
    let logs = get_remote_logs(log_cache, query.remote_name)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_logs = serde_json::to_value(logs).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_logs)))
}

pub async fn clear_remote_logs_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteLogsQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::state::log::clear_remote_logs;
    let log_cache = state.app_handle.state::<LogCache>();
    clear_remote_logs(log_cache, query.remote_name)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.system.logsCleared"
    ))))
}

// SSE
pub async fn sse_handler(
    State(state): State<WebServerState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.event_tx.subscribe();
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                    yield Ok(Event::default().data(data));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    yield Ok(Event::default().event("error").data("{\"error\":\"event stream lagged\"}"));
                }
                Err(broadcast::error::RecvError::Closed) => { break; }
            }
        }
    };
    info!("📡 New SSE client connected");
    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

// Updates
#[cfg(feature = "updater")]
#[derive(Deserialize)]
pub struct FetchUpdateQuery {
    pub channel: String,
}

#[cfg(feature = "updater")]
pub async fn fetch_update_handler(
    State(state): State<WebServerState>,
    Query(query): Query<FetchUpdateQuery>,
) -> Result<Json<ApiResponse<Option<serde_json::Value>>>, AppError> {
    let pending_update = state.app_handle.state::<PendingUpdate>();
    let download_state = state.app_handle.state::<DownloadState>();
    let result = fetch_update(
        state.app_handle.clone(),
        pending_update,
        download_state,
        query.channel,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    let json_result = result.map(|r| serde_json::to_value(r)).transpose()?;
    Ok(Json(ApiResponse::success(json_result)))
}

#[cfg(not(feature = "updater"))]
pub async fn fetch_update_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Option<serde_json::Value>>>, AppError> {
    Ok(Json(ApiResponse::success(None)))
}

#[cfg(feature = "updater")]
pub async fn get_download_status_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    let download_state = state.app_handle.state::<DownloadState>();
    let status = get_download_status(download_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_status = serde_json::to_value(status)?;
    Ok(Json(ApiResponse::success(json_status)))
}

#[cfg(not(feature = "updater"))]
pub async fn get_download_status_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    Ok(Json(ApiResponse::success(serde_json::json!({}))))
}

#[cfg(feature = "updater")]
pub async fn install_update_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let pending_update = state.app_handle.state::<PendingUpdate>();
    let download_state = state.app_handle.state::<DownloadState>();
    install_update(state.app_handle.clone(), pending_update, download_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(crate::localized_success!(
        "backendSuccess.system.updateInstalled"
    ))))
}

#[cfg(not(feature = "updater"))]
pub async fn install_update_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    Ok(Json(ApiResponse::success("Updates disabled".to_string())))
}

pub async fn relaunch_app_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::utils::app::platform::relaunch_app;
    relaunch_app(state.app_handle.clone());
    Ok(Json(ApiResponse::success(
        "App relaunched successfully".to_string(),
    )))
}

pub async fn are_updates_disabled_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::utils::app::platform::are_updates_disabled;
    let disabled = are_updates_disabled();
    Ok(Json(ApiResponse::success(disabled)))
}

pub async fn get_build_type_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Option<String>>>, AppError> {
    use crate::utils::app::platform::get_build_type;
    let build_type = get_build_type().map(|s| s.to_string());
    Ok(Json(ApiResponse::success(build_type)))
}
