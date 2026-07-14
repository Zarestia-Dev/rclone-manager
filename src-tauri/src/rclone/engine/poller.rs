use std::sync::atomic::Ordering;
use std::time::Duration;

use log::{debug, error, warn};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time;

use crate::rclone::backend::BackendManager;
use crate::rclone::engine::lifecycle::{get_engine_status, start_engine_if_not_running};
use crate::rclone::queries::parse_serves_response;
use crate::utils::rclone::endpoints::{core, job, mount, serve};
use crate::utils::types::events::SYSTEM_STATUS;
use crate::utils::types::monitoring::{SystemStatus, SystemStatusPayload};
use crate::utils::types::remotes::MountedRemote;
use crate::utils::types::state::{EngineState, RcloneState};

const BURST_TICK_COUNT: u32 = 5;

#[tauri::command]
pub async fn get_system_status_snapshot(
    app_handle: AppHandle,
) -> Result<SystemStatusPayload, String> {
    let status = get_engine_status(&app_handle).await;
    if status.is_inactive() {
        return Ok(SystemStatusPayload::inactive());
    }

    match perform_batch_poll(&app_handle).await {
        Ok(payload) => Ok(payload),
        Err(e) => {
            warn!("Failed to fetch system status snapshot: {e}");
            Ok(SystemStatusPayload::error())
        }
    }
}

#[tauri::command]
pub fn set_poller_visibility(app_handle: AppHandle, visible: bool) -> Result<(), String> {
    app_handle
        .state::<RcloneState>()
        .poller_visible
        .store(visible, Ordering::Relaxed);
    Ok(())
}

pub fn start_system_poller(app_handle: AppHandle) {
    if app_handle
        .state::<RcloneState>()
        .poller_running
        .swap(true, Ordering::AcqRel)
    {
        debug!("System poller already running");
        return;
    }

    tauri::async_runtime::spawn(async move {
        debug!("Starting unified system poller");
        let mut has_active_jobs = false;
        let mut burst_ticks = BURST_TICK_COUNT;
        let mut prev_visible = true;
        let mut interval = time::interval(Duration::from_secs(1));

        loop {
            interval.tick().await;

            let state = app_handle.state::<RcloneState>();
            if !state.poller_running.load(Ordering::Acquire) {
                debug!("Stopping system poller");
                break;
            }

            if state.is_shutting_down() {
                break;
            }

            let status = get_engine_status(&app_handle).await;
            let should_skip = status.is_inactive();

            if should_skip {
                burst_ticks = BURST_TICK_COUNT;
                if !status.running {
                    let _ = app_handle.emit(SYSTEM_STATUS, SystemStatusPayload::inactive());
                    if status.auth_failed {
                        crate::rclone::engine::lifecycle::emit_block_status_for_phase(&app_handle)
                            .await;
                    } else if !status.updating && !status.should_exit {
                        start_engine_if_not_running(&app_handle).await;
                    }
                }
                continue;
            }

            if state.initial_startup.load(Ordering::Acquire) {
                debug!("Skipping poll during initial startup");
                continue;
            }

            let is_visible = state.poller_visible.load(Ordering::Relaxed);

            if is_visible && !prev_visible {
                debug!("Visibility restored, triggering burst mode");
                burst_ticks = BURST_TICK_COUNT;
            }
            prev_visible = is_visible;

            match perform_batch_poll(&app_handle).await {
                Ok(payload) => {
                    has_active_jobs = payload.has_active_jobs;
                    burst_ticks = burst_ticks.saturating_sub(1);
                    let _ = app_handle.emit(SYSTEM_STATUS, payload);
                }
                Err(e) => {
                    if is_auth_error(&e) {
                        error!("Poller batch failed with auth error (not restarting): {e}");
                        mark_engine_auth_failed(&app_handle, e).await;
                    } else {
                        error!("Poller batch failed, restarting engine: {e}");
                        crate::rclone::engine::lifecycle::mark_engine_dead(&app_handle).await;
                        start_engine_if_not_running(&app_handle).await;
                    }
                    burst_ticks = BURST_TICK_COUNT;
                    let _ = app_handle.emit(SYSTEM_STATUS, SystemStatusPayload::error());
                }
            }

            let new_duration = if burst_ticks > 0 {
                Duration::from_secs(1)
            } else if !is_visible {
                Duration::from_secs(10)
            } else if has_active_jobs {
                Duration::from_secs(1)
            } else {
                Duration::from_secs(5)
            };

            if interval.period() != new_duration {
                debug!(
                    "Adjusting poller interval to {new_duration:?} (burst_ticks: {burst_ticks})"
                );
                interval = time::interval_at(time::Instant::now() + new_duration, new_duration);
            }
        }

        app_handle
            .state::<RcloneState>()
            .poller_running
            .store(false, Ordering::Release);
    });
}

fn is_auth_error(err: &str) -> bool {
    err.contains("HTTP 401") || err.contains("HTTP 403")
}

async fn mark_engine_auth_failed(app: &AppHandle, raw_error: String) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.mark_auth_failed(raw_error);
    drop(engine);
    crate::rclone::engine::lifecycle::emit_block_status_for_phase(app).await;
}

fn get_batch_result<'a>(
    result_obj: &'a serde_json::Value,
    endpoint_name: &str,
) -> Option<&'a serde_json::Value> {
    if result_obj.is_null() {
        debug!("Batch result for {endpoint_name} is null");
        return None;
    }

    if let Some(error) = result_obj.get("error") {
        let error_str = error.as_str().unwrap_or("");
        if !error_str.is_empty() {
            debug!("Batch result for {endpoint_name} has error: {error_str}");
            return None;
        }
    }

    Some(result_obj)
}

async fn perform_batch_poll(app: &AppHandle) -> Result<SystemStatusPayload, String> {
    let backend_manager = app.state::<BackendManager>();
    let transport = app.state::<RcloneState>().transport.clone();

    let batch_payload = json!({
        "inputs": [
            { "_path": core::STATS },
            { "_path": core::MEMSTATS },
            { "_path": mount::LISTMOUNTS },
            { "_path": serve::LIST },
        ]
    });

    let response = transport
        .rpc(job::BATCH, Some(&batch_payload))
        .await
        .map_err(|e| e.to_string())?;

    if let Some(error) = response.get("error") {
        return Err(error.as_str().unwrap_or("Unknown batch error").to_string());
    }

    let results = response["results"]
        .as_array()
        .ok_or("Invalid batch response: missing results array")?;

    if results.len() < 4 {
        return Err("Invalid batch response: insufficient results".to_string());
    }

    let stats = get_batch_result(&results[0], "stats")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let memory = get_batch_result(&results[1], "memstats")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let mount_result = get_batch_result(&results[2], "mounts");
    let serve_result = get_batch_result(&results[3], "serves");

    if let Some(mount_result) = mount_result {
        update_mount_cache(app, mount_result).await;
    }

    if let Some(serve_result) = serve_result {
        update_serve_cache(app, serve_result).await;
    }

    let active_name = backend_manager.get_active_name().await;
    let runtime = backend_manager.get_runtime_info(&active_name).await;

    Ok(SystemStatusPayload {
        rclone_info: runtime.as_ref().and_then(|r| r.core_version.clone()),
        pid: runtime.as_ref().and_then(|r| r.pid),
        stats,
        memory,
        status: SystemStatus::Active,
        has_active_jobs: backend_manager.job_cache.has_running_jobs().await,
    })
}

async fn update_mount_cache(app: &AppHandle, result: &serde_json::Value) {
    let mounts: Vec<MountedRemote> =
        result["mountPoints"]
            .as_array()
            .map_or_else(Vec::new, |arr| {
                arr.iter()
                    .filter_map(|mp| {
                        Some(MountedRemote {
                            fs: mp["Fs"].as_str()?.to_string(),
                            mount_point: mp["MountPoint"].as_str()?.to_string(),
                            profile: None,
                        })
                    })
                    .collect()
            });

    app.state::<BackendManager>()
        .remote_cache
        .update_mounts_if_changed(mounts, app)
        .await;
}

async fn update_serve_cache(app: &AppHandle, result: &serde_json::Value) {
    let serves = parse_serves_response(result);
    app.state::<BackendManager>()
        .remote_cache
        .update_serves_if_changed(serves, app)
        .await;
}
