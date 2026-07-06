use log::{debug, error, info};
use serde_json::json;
#[cfg(not(feature = "librclone"))]
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(feature = "librclone"))]
use tokio::io::{AsyncBufReadExt, BufReader};
#[cfg(not(feature = "librclone"))]
use tokio::net::TcpStream;
#[cfg(not(feature = "librclone"))]
use tokio::time::sleep;

use crate::{
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

#[cfg(not(feature = "librclone"))]
use crate::utils::rclone::process_common::{build_rclone_process_command, graceful_shutdown};
#[cfg(not(feature = "librclone"))]
use crate::utils::types::events::RCLONE_OAUTH_URL;
#[cfg(not(feature = "librclone"))]
use crate::utils::types::rclone::ProcessKind;

#[derive(Debug)]
pub enum RcloneError {
    RequestFailed(String),
    ParseError(String),
    JobError(String),
    #[cfg(not(feature = "librclone"))]
    OAuthError(String),
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
                crate::localized_error!("backendErrors.request.failed", "error" => e)
            ),
            RcloneError::ParseError(e) => write!(
                f,
                "{}",
                crate::localized_error!("backendErrors.serve.parseFailed", "error" => e)
            ),
            RcloneError::JobError(e) => write!(
                f,
                "{}",
                crate::localized_error!("backendErrors.job.executionFailed", "error" => e)
            ),
            #[cfg(not(feature = "librclone"))]
            RcloneError::OAuthError(e) => write!(
                f,
                "{}",
                crate::localized_error!("backendErrors.request.failed", "error" => e)
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

/// Desktop-only: spawns a separate `rclone authorize` subprocess for the OAuth flow.
/// On mobile (librclone), OAuth uses the `config/oauthstatus` + `config/oauthstop`
/// rc endpoints instead (see `commands/remote.rs`).
#[cfg(not(feature = "librclone"))]
pub async fn ensure_oauth_process(app: &AppHandle) -> Result<(), RcloneError> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    if !backend.is_local {
        return Ok(());
    }

    // Pre-build command outside the lock to keep the critical section small.
    let cmd = build_rclone_process_command(app, ProcessKind::OAuth)
        .await
        .map_err(|e| RcloneError::OAuthError(format!("Failed to build OAuth command: {e}")))?;

    let state = app.state::<RcloneState>();
    let mut guard = state.oauth_process.lock().await;

    // 1. Check if we already have a tracked process and if it's still alive.
    if let Some(process) = guard.as_mut() {
        if let Ok(None) = process.try_wait() {
            debug!("OAuth process is already tracked and running");
            return Ok(());
        }
        debug!("Tracked OAuth process is dead, clearing handle");
        *guard = None;
    }

    let addr = backend.oauth_addr();

    // 2. Probe port availability with a small TOCTOU window.
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => {
            // Port is free, drop immediately to allow rclone to bind.
            drop(l);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            log::warn!(
                "OAuth port {} is already in use, assuming another instance or orphan is running",
                backend.oauth_port
            );
            return Ok(());
        }
        Err(e) => {
            return Err(RcloneError::OAuthError(format!(
                "Failed to probe OAuth port {}: {e}",
                backend.oauth_port
            )));
        }
    }

    // 3. Spawn the process and update the guard immediately.
    let mut process = cmd.spawn().map_err(|e| {
        RcloneError::OAuthError(format!(
            "Failed to spawn OAuth process: {e}. Is rclone installed and in PATH?"
        ))
    })?;

    info!("Rclone OAuth process spawned");

    let stderr = process
        .stderr
        .take()
        .expect("stderr must be piped — set in create_oauth_tokio_command");

    *guard = Some(process);

    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            debug!("[oauth] {line}");

            if let Some(url) = extract_oauth_auth_url(&line) {
                info!("OAuth URL ready: {url}");
                if let Err(e) = app_clone.emit(RCLONE_OAUTH_URL, json!({ "url": url })) {
                    log::warn!("Failed to emit OAuth URL event: {e}");
                }
                // Keep reading — the process must stay alive to receive the callback.
            }
        }
        debug!("OAuth stderr reader closed");
    });

    let start = Instant::now();
    let timeout = Duration::from_secs(5);

    while start.elapsed() < timeout {
        if TcpStream::connect(&addr).await.is_ok() {
            info!("Rclone OAuth process ready on port {}", backend.oauth_port);
            return Ok(());
        }

        if let Some(process_in_guard) = guard.as_mut()
            && let Ok(Some(status)) = process_in_guard.try_wait()
        {
            if TcpStream::connect(&addr).await.is_ok() {
                log::warn!(
                    "OAuth process exited but port is taken; assuming another instance won the race"
                );
                *guard = None;
                return Ok(());
            }
            *guard = None;
            return Err(RcloneError::OAuthError(format!(
                "OAuth process exited prematurely with status {status}"
            )));
        }

        sleep(Duration::from_millis(100)).await;
    }

    *guard = None;
    Err(RcloneError::OAuthError(format!(
        "Timeout waiting for OAuth process to start on port {}",
        backend.oauth_port
    )))
}

#[cfg(not(feature = "librclone"))]
fn extract_oauth_auth_url(line: &str) -> Option<String> {
    line.split_whitespace().find_map(|token| {
        let candidate = token.trim_matches(|c: char| {
            c == '"' || c == '\'' || c == '(' || c == ')' || c == '[' || c == ']'
        });

        if (candidate.starts_with("http://") || candidate.starts_with("https://"))
            && candidate.contains("/auth?")
        {
            Some(candidate.to_string())
        } else {
            None
        }
    })
}

/// Quit the main rclone engine via API (works for both local and remote backends).
///
/// Desktop-only: sends `core/quit` to the rcd daemon. On mobile (librclone),
/// there's no daemon to quit — the engine shuts down via `RcloneFinalize` in
/// the shutdown handler.
#[cfg(not(feature = "librclone"))]
#[tauri::command]
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

/// Clean up the OAuth rclone process.
///
/// Desktop-only: manages the spawned OAuth helper subprocess. On mobile
/// (librclone), OAuth uses rc endpoints and there's no subprocess to clean up.
#[cfg(not(feature = "librclone"))]
#[tauri::command]
pub async fn cancel_oauth(app: AppHandle) -> Result<(), String> {
    info!("Quitting rclone OAuth process");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    if !backend.is_local {
        return Ok(());
    }

    let state = app.state::<RcloneState>();
    let mut guard = state.oauth_process.lock().await;
    let quit_url = backend.oauth_url_for(core::QUIT);

    if let Some(process) = guard.take() {
        let quit_request = backend.inject_auth(state.client.post(&quit_url));
        graceful_shutdown(process, quit_request).await.map_err(
            |e| crate::localized_error!("backendErrors.system.killFailed", "error" => e),
        )?;
    } else if TcpStream::connect(backend.oauth_addr()).await.is_ok() {
        // Process is alive but we have no handle — send a quit request and wait briefly.
        let _ = backend
            .inject_auth(state.client.post(&quit_url))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        tokio::time::sleep(Duration::from_secs(2)).await;
    } else {
        log::warn!("No active OAuth process found");
        return Ok(());
    }

    info!("Rclone OAuth process terminated");
    Ok(())
}

#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
pub async fn clear_fscache(app: AppHandle) -> Result<(), String> {
    info!("Clearing filesystem cache");

    let transport = app.state::<RcloneState>().transport.clone();

    transport
        .rpc(fscache::CLEAR, None)
        .await
        .map(|_| ())
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))
}

// ============================================================================
// STATS GROUP MANAGEMENT
// ============================================================================

/// Get all active stats groups.
/// Returns a list of group names like ["sync/gdrive", "mount/onedrive"].
#[tauri::command]
pub async fn get_stats_groups(app: AppHandle) -> Result<Vec<String>, String> {
    let transport = app.state::<RcloneState>().transport.clone();

    let json = transport
        .rpc(core::GROUP_LIST, None)
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let groups = json
        .get("groups")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Ok(groups)
}

/// Reset stats for a specific group, or all groups if `group` is None.
#[tauri::command]
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

/// Delete a stats group entirely.
#[tauri::command]
pub async fn delete_stats_group(app: AppHandle, group: String) -> Result<(), String> {
    let transport = app.state::<RcloneState>().transport.clone();

    transport
        .rpc(core::STATS_DELETE, Some(&json!({ "group": group })))
        .await
        .map(|_| info!("Stats group '{group}' deleted"))
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))
}
