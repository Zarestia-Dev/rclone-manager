use log::{debug, error, info, warn};
use serde_json::json;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::sleep;

use crate::{
    rclone::backend::BackendManager,
    utils::{
        rclone::{
            endpoints::{config, core, fscache},
            process_common::build_rclone_process_command,
        },
        types::{
            core::{BandwidthLimitResponse, ProcessKind, RcloneState},
            events::{BANDWIDTH_LIMIT_CHANGED, RCLONE_CONFIG_UNLOCKED, RCLONE_OAUTH_URL},
        },
    },
};

#[derive(Debug)]
pub enum RcloneError {
    RequestFailed(String),
    ParseError(String),
    JobError(String),
    OAuthError(String),
    ConfigError(String),
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
            RcloneError::OAuthError(e) => write!(
                f,
                "{}",
                crate::localized_error!("backendErrors.request.failed", "error" => e)
            ),
            RcloneError::ConfigError(e) => write!(
                f,
                "{}",
                crate::localized_error!("backendErrors.sync.configIncomplete", "profile" => e)
            ),
        }
    }
}

/// Try to auto-unlock config for remote backends with stored password.
/// This is only for remote backends — local backends use RCLONE_CONFIG_PASS env var.
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
    let state = app.state::<RcloneState>();

    backend
        .post_json(&state.client, config::UNLOCK, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.system.unlockFailed", "error" => e))?;

    app.emit(RCLONE_CONFIG_UNLOCKED, ())
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    info!("✅ Remote config unlocked");
    Ok(())
}

pub async fn ensure_oauth_process(app: &AppHandle) -> Result<(), RcloneError> {
    let state = app.state::<RcloneState>();
    let mut guard = state.oauth_process.lock().await;

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    if !backend.is_local {
        return Ok(());
    }

    if backend.oauth_port.is_none() {
        return Err(RcloneError::ConfigError("OAuth not configured".to_string()));
    }

    // Already tracked in memory — process is up, URL was already emitted.
    if guard.is_some() {
        return Ok(());
    }

    // Port already open from a previous run not tracked in memory.
    if let Some(addr) = backend.oauth_addr()
        && TcpStream::connect(&addr).await.is_ok()
    {
        warn!(
            "OAuth process already running on port {} (not tracked in memory)",
            backend.oauth_port.unwrap()
        );
        return Ok(());
    }

    // Build a tokio::process::Command with stderr piped.
    // This does NOT write a log file — output is consumed directly below.
    let cmd = build_rclone_process_command(app, ProcessKind::OAuth)
        .await
        .map_err(|e| RcloneError::OAuthError(format!("Failed to build OAuth command: {e}")))?;

    let mut process = cmd.spawn().map_err(|e| {
        RcloneError::OAuthError(format!(
            "Failed to spawn OAuth process: {e}. Is rclone installed and in PATH?"
        ))
    })?;

    info!("✅ Rclone OAuth process spawned");

    // Take stderr before moving the process into the guard.
    let stderr = process
        .stderr
        .take()
        .expect("stderr must be piped — set in create_oauth_tokio_command");

    *guard = Some(process);

    // Spawn a task that reads stderr and emits the auth URL immediately.
    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            debug!("[oauth] {}", line);

            if let Some(url) = extract_oauth_auth_url(&line) {
                info!("🔗 OAuth URL ready: {url}");
                if let Err(e) = app_clone.emit(RCLONE_OAUTH_URL, json!({ "url": url })) {
                    warn!("Failed to emit OAuth URL event: {e}");
                }
                // Keep reading — the process must stay alive to receive the callback.
            }
        }
        info!("OAuth stderr reader closed");
    });

    // Wait until the rc port is open (process is accepting connections).
    let start = Instant::now();
    let timeout = Duration::from_secs(5);

    while start.elapsed() < timeout {
        if let Some(addr) = backend.oauth_addr()
            && TcpStream::connect(&addr).await.is_ok()
        {
            info!(
                "✅ Rclone OAuth process ready on port {}",
                backend.oauth_port.unwrap()
            );
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    Err(RcloneError::OAuthError(format!(
        "Timeout waiting for OAuth process to start on port {:?}",
        backend.oauth_port
    )))
}

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
#[tauri::command]
pub async fn quit_rclone_engine(app: AppHandle) -> Result<(), String> {
    info!("🛑 Quitting Rclone engine via API");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let quit_url = backend.url_for(core::QUIT);

    match backend
        .inject_auth(app.state::<RcloneState>().client.post(&quit_url))
        .send()
        .await
    {
        Ok(_) => {
            info!("✅ Rclone engine quit request sent");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to quit rclone engine: {e}");
            Err(crate::localized_error!(
                "backendErrors.system.quitFailed",
                "error" => e
            ))
        }
    }
}

/// Clean up the OAuth rclone process.
#[tauri::command]
pub async fn quit_rclone_oauth(app: AppHandle) -> Result<(), String> {
    info!("🛑 Quitting Rclone OAuth process");

    let state = app.state::<RcloneState>();
    let mut guard = state.oauth_process.lock().await;

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    if !backend.is_local {
        return Ok(());
    }

    if backend.oauth_port.is_none() {
        return Err(crate::localized_error!(
            "backendErrors.system.oauthNotConfigured"
        ));
    }

    let found_process = guard.is_some() || {
        backend
            .oauth_addr()
            .map(|addr| {
                // Using a sync check here is fine — this is a command handler, not a hot path.
                std::net::TcpStream::connect(&addr).is_ok()
            })
            .unwrap_or(false)
    };

    if !found_process {
        warn!("⚠️ No active OAuth process found (not in memory, port not open)");
        return Ok(());
    }

    // Ask rclone to quit gracefully first.
    if let Some(url) = backend.oauth_url_for(core::QUIT)
        && let Err(e) = backend.inject_auth(state.client.post(&url)).send().await
    {
        warn!("⚠️ Failed to send OAuth quit request: {e}");
    }

    // Kill the process if we're tracking it.
    if let Some(mut process) = guard.take() {
        if let Err(e) = process.kill().await {
            error!("❌ Failed to kill OAuth process: {e}");
            return Err(crate::localized_error!(
                "backendErrors.system.killFailed",
                "error" => e
            ));
        }
        info!("💀 Rclone OAuth process killed");
    } else {
        // Not tracked — give it a moment to exit after the quit request.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    info!("✅ Rclone OAuth process quit successfully");
    Ok(())
}

#[tauri::command]
pub async fn set_bandwidth_limit(
    app: AppHandle,
    rate: Option<String>,
) -> Result<BandwidthLimitResponse, String> {
    let rate_value = match rate {
        Some(ref s) if s.trim().is_empty() => "off".to_string(),
        Some(s) => s,
        _ => "off".to_string(),
    };

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let payload = json!({ "rate": rate_value });

    let json = backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::BWLIMIT,
            Some(&payload),
        )
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let response_data: BandwidthLimitResponse =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse response: {e}"))?;

    debug!("🪢 Bandwidth limit set: {response_data:?}");

    if let Err(e) = app.emit(BANDWIDTH_LIMIT_CHANGED, response_data.clone()) {
        error!("❌ Failed to emit bandwidth limit changed event: {e}");
    }

    Ok(response_data)
}

pub async fn unlock_rclone_config(app: AppHandle, password: String) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let payload = json!({ "configPassword": password });

    let _ = backend
        .post_json(
            &app.state::<RcloneState>().client,
            config::UNLOCK,
            Some(&payload),
        )
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    app.emit(RCLONE_CONFIG_UNLOCKED, ())
        .map_err(|e| format!("Failed to emit config unlocked event: {e}"))?;

    Ok(())
}

/// Runs the garbage collector.
#[tauri::command]
pub async fn run_garbage_collector(app: AppHandle) -> Result<(), String> {
    info!("🧹 Running garbage collector");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let _ = backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::GC,
            Some(&json!({})),
        )
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    info!("✅ Garbage collector run successfully");
    Ok(())
}

/// Get the number of entries in the filesystem cache.
#[tauri::command]
pub async fn get_fscache_entries(app: AppHandle) -> Result<usize, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let json = backend
        .post_json(&app.state::<RcloneState>().client, fscache::ENTRIES, None)
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let entries = json
        .get("entries")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .ok_or_else(|| "Failed to parse entries count".to_string())?;

    Ok(entries)
}

/// Clear the filesystem cache.
#[tauri::command]
pub async fn clear_fscache(app: AppHandle) -> Result<(), String> {
    info!("🧹 Clearing filesystem cache");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let _ = backend
        .post_json(&app.state::<RcloneState>().client, fscache::CLEAR, None)
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    info!("✅ Filesystem cache cleared");
    Ok(())
}

// ============================================================================
// STATS GROUP MANAGEMENT
// ============================================================================

/// Get all active stats groups.
/// Returns a list of group names like ["sync/gdrive", "mount/onedrive"].
#[tauri::command]
pub async fn get_stats_groups(app: AppHandle) -> Result<Vec<String>, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let json = backend
        .post_json(&app.state::<RcloneState>().client, core::GROUP_LIST, None)
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let groups = json
        .get("groups")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    Ok(groups)
}

/// Reset stats for a specific group, or all groups if `group` is None.
#[tauri::command]
pub async fn reset_group_stats(app: AppHandle, group: Option<String>) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let payload = group.as_ref().map(|g| json!({ "group": g }));

    let _ = backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::STATS_RESET,
            payload.as_ref(),
        )
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    info!(
        "✅ Stats reset for group: {}",
        group.as_deref().unwrap_or("all")
    );
    Ok(())
}

/// Delete a stats group entirely.
#[tauri::command]
pub async fn delete_stats_group(app: AppHandle, group: String) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let _ = backend
        .post_json(
            &app.state::<RcloneState>().client,
            core::STATS_DELETE,
            Some(&json!({ "group": group })),
        )
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    info!("✅ Stats group '{group}' deleted");
    Ok(())
}
