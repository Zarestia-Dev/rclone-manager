use log::{debug, error, warn};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time;

const BURST_TICK_COUNT: u32 = 5;

use crate::rclone::backend::BackendManager;
use crate::rclone::queries::parse_serves_response;
use crate::utils::rclone::endpoints::{core, job, mount, serve};
use crate::utils::types::events::SYSTEM_STATUS;
use crate::utils::types::monitoring::SystemStatus;
use crate::utils::types::monitoring::SystemStatusPayload;
use crate::utils::types::remotes::MountedRemote;
use crate::utils::types::state::{EngineState, RcloneState};

/// Update the system poller visibility state
#[tauri::command]
pub fn set_poller_visibility(app_handle: AppHandle, visible: bool) -> Result<(), String> {
    debug!("🔄 System poller visibility set to: {}", visible);
    app_handle
        .state::<RcloneState>()
        .poller_visible
        .store(visible, Ordering::SeqCst);
    Ok(())
}

/// Background task that performs unified system monitoring
pub fn start_system_poller(app_handle: AppHandle) {
    if app_handle
        .state::<RcloneState>()
        .poller_running
        .swap(true, Ordering::SeqCst)
    {
        debug!("🔄 System poller already running");
        return;
    }

    tauri::async_runtime::spawn(async move {
        debug!("🔄 Starting unified system poller");
        let mut consecutive_failures = 0;
        let mut has_active_jobs = false;
        let mut burst_ticks = BURST_TICK_COUNT; // Start with a burst on startup
        let mut prev_visible = true;
        let mut interval = time::interval(Duration::from_secs(1));

        loop {
            interval.tick().await;

            let state = app_handle.state::<RcloneState>();
            if !state.poller_running.load(Ordering::SeqCst) {
                debug!("🔄 Stopping system poller");
                break;
            }

            if state.is_shutting_down() {
                break;
            }

            // Skip polling if engine is not running or is updating
            let (should_skip, should_emit_inactive) = {
                let engine_state = app_handle.state::<EngineState>();
                let engine = engine_state.lock().await;
                (
                    !engine.running || engine.updating || engine.should_exit,
                    !engine.running,
                )
            };

            if should_skip {
                consecutive_failures = 0;
                burst_ticks = BURST_TICK_COUNT; // Reset burst for when engine comes back
                if should_emit_inactive {
                    let _ = app_handle.emit(SYSTEM_STATUS, SystemStatusPayload::inactive());
                }
                continue;
            }

            // Skip during initial startup sequence
            if state.initial_startup.load(Ordering::Acquire) {
                debug!("🔄 Skipping poll during initial startup");
                continue;
            }

            // Determine visibility state for burst detection
            let is_visible = state.poller_visible.load(Ordering::SeqCst);

            // Trigger burst mode when switching from hidden to visible
            if is_visible && !prev_visible {
                debug!("🔄 Visibility restored, triggering burst mode");
                burst_ticks = BURST_TICK_COUNT;
            }
            prev_visible = is_visible;

            match perform_batch_poll(&app_handle).await {
                Ok(payload) => {
                    consecutive_failures = 0;
                    has_active_jobs = payload.has_active_jobs;
                    burst_ticks = burst_ticks.saturating_sub(1);
                    let _ = app_handle.emit(SYSTEM_STATUS, payload);
                }
                Err(e) => {
                    consecutive_failures += 1;
                    warn!("🔄 System poller batch failed ({consecutive_failures}/3): {e}");

                    if consecutive_failures >= 3 {
                        error!(
                            "🔄 System poller reached failure threshold, triggering engine restart"
                        );
                        let engine_state = app_handle.state::<EngineState>();
                        let mut engine = engine_state.lock().await;
                        if !engine.should_exit {
                            crate::rclone::engine::lifecycle::start(&mut engine, &app_handle).await;
                        }
                        consecutive_failures = 0; // Reset after restart attempt
                        burst_ticks = BURST_TICK_COUNT; // Reset burst for restart
                    }

                    let _ = app_handle.emit(SYSTEM_STATUS, SystemStatusPayload::error());
                }
            }

            let new_duration = if burst_ticks > 0 {
                Duration::from_secs(1) // Burst: Fast poll regardless of state
            } else if !is_visible {
                Duration::from_secs(10) // Hidden: Slow poll
            } else if has_active_jobs {
                Duration::from_secs(1) // Visible + Active: Fast poll
            } else {
                Duration::from_secs(5) // Visible + Idle: Medium poll
            };

            if interval.period() != new_duration {
                debug!(
                    "🔄 Adjusting poller interval to {:?} (burst_ticks: {})",
                    new_duration, burst_ticks
                );
                interval = time::interval_at(time::Instant::now() + new_duration, new_duration);
            }
        }
        app_handle
            .state::<RcloneState>()
            .poller_running
            .store(false, Ordering::SeqCst);
    });
}

/// Stop the unified system poller
pub fn stop_system_poller(app_handle: &AppHandle) {
    let state = app_handle.state::<RcloneState>();
    state.poller_running.store(false, Ordering::SeqCst);
}

/// Parse a single batch result - batch returns results directly, not wrapped
fn parse_batch_result(result_obj: &serde_json::Value, endpoint_name: &str) -> serde_json::Value {
    if result_obj.is_null() {
        debug!("⚠️  Batch result for {endpoint_name} is null");
        return serde_json::Value::Null;
    }

    // Check for error field (rclone batch returns this directly in the result)
    if let Some(error) = result_obj.get("error") {
        let error_str = error.as_str().unwrap_or("");
        if !error_str.is_empty() {
            debug!("⚠️  Batch result for {endpoint_name} has error: {error_str}");
            return serde_json::Value::Null;
        }
    }

    // Batch returns results directly (not wrapped in {"result": ..., "error": ...})
    result_obj.clone()
}

async fn perform_batch_poll(app: &AppHandle) -> Result<SystemStatusPayload, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = &app.state::<RcloneState>().client;

    let batch_payload = json!({
        "inputs": [
            { "_path": core::STATS },
            { "_path": core::MEMSTATS },
            { "_path": mount::LISTMOUNTS },
            { "_path": serve::LIST },
        ]
    });

    let response = backend
        .post_json(client, job::BATCH, Some(&batch_payload))
        .await
        .map_err(|e| e.to_string())?;

    // 1. Check for global batch error FIRST
    if let Some(error) = response.get("error") {
        return Err(error.as_str().unwrap_or("Unknown batch error").to_string());
    }

    // 2. Then parse results
    let results = response["results"]
        .as_array()
        .ok_or("Invalid batch response: missing results array")?;

    if results.len() < 4 {
        return Err("Invalid batch response: insufficient results".to_string());
    }

    // Parse results - check for errors and null values in each result
    let stats = parse_batch_result(&results[0], "stats");
    let memory = parse_batch_result(&results[1], "memstats");
    let mount_result = parse_batch_result(&results[2], "mounts");
    let serve_result = parse_batch_result(&results[3], "serves");

    // Only update caches if results are valid (not null)
    if !mount_result.is_null() {
        update_mount_cache(app, &mount_result).await;
    }

    if !serve_result.is_null() {
        update_serve_cache(app, &serve_result).await;
    }

    // Get cached static info
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

    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .remote_cache
        .update_mounts_if_changed(mounts, app)
        .await;
}

async fn update_serve_cache(app: &AppHandle, result: &serde_json::Value) {
    let serves = parse_serves_response(result);
    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .remote_cache
        .update_serves_if_changed(serves, app)
        .await;
}
