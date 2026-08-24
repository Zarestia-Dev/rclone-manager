use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::bridge,
    rclone::backend::BackendManager,
    utils::{
        rclone::endpoints::{config, core, fscache},
        types::{
            events::{BANDWIDTH_LIMIT_CHANGED, RCLONE_CONFIG_UNLOCKED},
            rclone::BandwidthLimitResponse,
            state::RcloneState,
        },
    },
};

#[derive(Debug)]
pub enum RcloneError {
    RequestFailed(String),
    ParseError(String),
    JobError(String),
}

impl From<reqwest::Error> for RcloneError {
    fn from(err: reqwest::Error) -> Self {
        RcloneError::RequestFailed(err.to_string())
    }
}

impl From<serde_json::Error> for RcloneError {
    fn from(err: serde_json::Error) -> Self {
        RcloneError::ParseError(err.to_string())
    }
}

impl std::fmt::Display for RcloneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RcloneError::RequestFailed(e) => write!(
                f,
                "{}",
                crate::rclone::engine::error_mapper::map_rclone_error(e).unwrap_or_else(|| {
                    crate::localized_error!("backendErrors.request.failed", "error" => e)
                })
            ),
            RcloneError::ParseError(e) => write!(
                f,
                "{}",
                crate::localized_error!("backendErrors.serve.parseFailed", "error" => e)
            ),
            RcloneError::JobError(e) => write!(
                f,
                "{}",
                crate::rclone::engine::error_mapper::map_or_wrap_job_error(e)
            ),
        }
    }
}

/// Try to auto-unlock config for remote backends with stored password.
/// This is only for remote backends — local backends use `RCLONE_CONFIG_PASS` env var.
pub async fn try_auto_unlock_config(app: &AppHandle) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    if backend.is_local {
        return Ok(());
    }

    let password = match &backend.config_password {
        Some(p) if !p.is_empty() => p.clone(),
        _ => return Ok(()),
    };

    let payload = json!({ "configPassword": password });
    let transport = app.state::<RcloneState>().transport.clone();

    transport
        .rpc(config::UNLOCK, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.system.unlockFailed", "error" => e))?;

    app.emit(RCLONE_CONFIG_UNLOCKED, ())
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    info!("Remote config unlocked");
    Ok(())
}

/// Quit the main rclone engine via API (works for both local and remote backends).
///
/// Desktop-only: sends `core/quit` to the rcd daemon. On mobile (librclone),
/// there's no daemon to quit — the engine shuts down via `RcloneFinalize` in
/// the shutdown handler.
#[cfg(not(feature = "librclone"))]
#[bridge]
pub async fn quit_rclone_engine(app: AppHandle) -> Result<(), String> {
    info!("Quitting rclone engine");

    // Fire-and-forget: the daemon is about to exit, so we don't care about
    // the response. The HTTP transport will typically return a connection-
    // reset error here because rclone closes the socket mid-response — that's
    // expected and not a real failure.
    let transport = app.state::<RcloneState>().transport.clone();
    match transport.rpc(core::QUIT, None).await {
        Ok(_) => info!("Rclone engine quit request sent"),
        Err(e) => error!("Failed to quit rclone engine: {e}"),
    }

    Ok(())
}

/// Cancel an in-progress OAuth flow.
///
/// Sends `config/oauthstop` over the active transport. Works for both
/// desktop (rcd) and mobile (librclone) — rclone v1.75+ runs the OAuth
/// server in-process and exposes this endpoint to stop it.
#[bridge]
pub async fn cancel_oauth(app: AppHandle) -> Result<(), String> {
    info!("Cancelling in-progress OAuth flow");
    let transport = app.state::<RcloneState>().transport.clone();
    transport
        .rpc(config::OAUTHSTOP, None)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to stop OAuth server: {e}"))
}

#[bridge]
pub async fn bandwidth_limit(
    app: AppHandle,
    rate: Option<String>,
) -> Result<BandwidthLimitResponse, String> {
    let payload = rate
        .filter(|s| !s.trim().is_empty())
        .map(|rate_value| json!({ "rate": rate_value }));

    let transport = app.state::<RcloneState>().transport.clone();
    let json = transport
        .rpc(core::BWLIMIT, payload.as_ref())
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let response_data: BandwidthLimitResponse =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse response: {e}"))?;

    debug!("Bandwidth limit set: {response_data:?}");

    if let Err(e) = app.emit(BANDWIDTH_LIMIT_CHANGED, response_data.clone()) {
        error!("Failed to emit bandwidth limit changed event: {e}");
    }

    Ok(response_data)
}

pub async fn unlock_rclone_config(app: AppHandle, password: String) -> Result<(), String> {
    let payload = json!({ "configPassword": password });
    let transport = app.state::<RcloneState>().transport.clone();

    let _ = transport
        .rpc(config::UNLOCK, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    app.emit(RCLONE_CONFIG_UNLOCKED, ())
        .map_err(|e| format!("Failed to emit config unlocked event: {e}"))?;

    Ok(())
}

/// Run the garbage collector.
#[bridge]
pub async fn run_garbage_collector(app: AppHandle) -> Result<(), String> {
    info!("Running garbage collector");

    let transport = app.state::<RcloneState>().transport.clone();

    transport
        .rpc(core::GC, Some(&json!({})))
        .await
        .map(|_| ())
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))
}

/// Get the number of entries in the filesystem cache.
#[bridge]
pub async fn get_fscache_entries(app: AppHandle) -> Result<usize, String> {
    let transport = app.state::<RcloneState>().transport.clone();

    let json = transport
        .rpc(fscache::ENTRIES, None)
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    json.get("entries")
        .and_then(serde_json::Value::as_u64)
        .map(|v| v as usize)
        .ok_or_else(|| "Failed to parse entries count".to_string())
}

/// Clear the filesystem cache.
#[bridge]
pub async fn clear_fscache(app: AppHandle) -> Result<(), String> {
    info!("Clearing filesystem cache");

    let transport = app.state::<RcloneState>().transport.clone();

    transport
        .rpc(fscache::CLEAR, None)
        .await
        .map(|_| ())
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))
}

/// Reset stats for a specific group, or all groups if `group` is None.
#[bridge]
pub async fn reset_group_stats(app: AppHandle, group: Option<String>) -> Result<(), String> {
    let payload = group.as_ref().map(|g| json!({ "group": g }));
    let transport = app.state::<RcloneState>().transport.clone();

    transport
        .rpc(core::STATS_RESET, payload.as_ref())
        .await
        .map(|_| {
            info!(
                "Stats reset for group: {}",
                group.as_deref().unwrap_or("all")
            );
        })
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))
}
