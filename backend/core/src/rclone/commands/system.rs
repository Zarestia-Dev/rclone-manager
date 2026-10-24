use crate::context::AppHandle;
use log::{debug, info};
use serde_json::json;

use crate::rclone::backend::BackendManager;
use crate::rclone::endpoints::config;
use crate::rclone::endpoints::core;
use crate::rclone::endpoints::fscache;
use crate::utils::types::events::BANDWIDTH_LIMIT_CHANGED;
use crate::utils::types::events::RCLONE_CONFIG_UNLOCKED;
use crate::utils::types::rclone::BandwidthLimitResponse;
use crate::utils::types::state::RcloneState;

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
    let transport = crate::rclone::backend::routing_transport::RoutingTransport::for_backend(
        app.clone(),
        backend,
    );

    transport
        .rpc(config::UNLOCK, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.system.unlockFailed", "error" => e))?;

    crate::services::bridge::emit(RCLONE_CONFIG_UNLOCKED, ());

    info!("Remote config unlocked");
    Ok(())
}

/// Quit the main rclone engine via API (works for both local and remote backends).
///
/// Desktop-only: sends `core/quit` to the rcd daemon. On mobile (librclone),
/// there's no daemon to quit — the engine shuts down via `RcloneFinalize` in
/// the shutdown handler.
#[cfg(not(feature = "librclone"))]
pub async fn quit_rclone_engine(app: AppHandle) -> Result<(), String> {
    info!("Quitting rclone engine");

    // Fire-and-forget: the daemon is about to exit, so we don't care about
    // the response. The HTTP transport will typically return a connection-
    // reset error here because rclone closes the socket mid-response — that's
    // expected and not a real failure.
    let transport = app.state::<RcloneState>().transport.clone();
    match transport.rpc(core::QUIT, None).await {
        Ok(_) => info!("Rclone engine quit request sent"),
        Err(e) => log::error!("Failed to quit rclone engine: {e}"),
    }

    Ok(())
}

/// Cancel an in-progress OAuth flow.
///
/// Sends `config/oauthstop` over the active transport. Works for both
/// desktop (rcd) and mobile (librclone) — rclone v1.75+ runs the OAuth
/// server in-process and exposes this endpoint to stop it.
pub async fn cancel_oauth(app: AppHandle) -> Result<(), String> {
    info!("Cancelling in-progress OAuth flow");
    let transport = app.state::<RcloneState>().transport.clone();
    match transport.rpc(config::OAUTHSTOP, None).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("no oauth authentication is in progress") {
                debug!("OAuth stop called when no OAuth flow was in progress; ignoring");
                Ok(())
            } else {
                Err(format!("Failed to stop OAuth server: {err_str}"))
            }
        }
    }
}

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

    crate::services::bridge::emit(BANDWIDTH_LIMIT_CHANGED, response_data.clone());

    Ok(response_data)
}

pub async fn unlock_rclone_config(app: AppHandle, password: String) -> Result<(), String> {
    let payload = json!({ "configPassword": password });
    let transport = app.state::<RcloneState>().transport.clone();

    let _ = transport
        .rpc(config::UNLOCK, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    crate::services::bridge::emit(RCLONE_CONFIG_UNLOCKED, ());

    Ok(())
}

/// Run the garbage collector.
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
