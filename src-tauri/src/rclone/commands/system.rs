use log::{debug, error, info, warn};
use serde_json::{Value, json};
use std::{
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpStream;
use tokio::time::sleep;

use crate::{
    rclone::backend::BACKEND_MANAGER,
    utils::{
        rclone::{
            endpoints::{EndpointHelper, config, core},
            process_common::create_rclone_command,
        },
        types::{
            all_types::{BandwidthLimitResponse, RcloneState, SENSITIVE_KEYS},
            events::{BANDWIDTH_LIMIT_CHANGED, RCLONE_CONFIG_UNLOCKED},
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
            RcloneError::RequestFailed(e) => write!(f, "Request failed: {e}"),
            RcloneError::ParseError(e) => write!(f, "Parse error: {e}"),
            RcloneError::JobError(e) => write!(f, "Job error: {e}"),
            RcloneError::OAuthError(e) => write!(f, "OAuth error: {e}"),
            RcloneError::ConfigError(e) => write!(f, "Config error: {e}"),
        }
    }
}

pub fn redact_sensitive_values(
    params: &std::collections::HashMap<String, Value>,
    restrict_mode: &Arc<RwLock<bool>>,
) -> Value {
    let restrict_enabled = restrict_mode
        .read()
        .map(|guard| *guard)
        .unwrap_or_else(|e| {
            log::error!("Failed to read restrict_mode: {e}");
            false // Default to false if we can't read
        });

    params
        .iter()
        .map(|(k, v)| {
            let value = if restrict_enabled
                && SENSITIVE_KEYS
                    .iter()
                    .any(|sk| k.to_lowercase().contains(sk))
            {
                json!("[RESTRICTED]")
            } else {
                v.clone()
            };
            (k.clone(), value)
        })
        .collect()
}

/// Try to auto-unlock config for remote backends with stored password
///
/// This is only for remote backends - local backends use RCLONE_CONFIG_PASS env var.
pub async fn try_auto_unlock_config(app: &AppHandle) -> Result<(), String> {
    let backend = BACKEND_MANAGER.get_active().await;

    // Only for remote backends
    if backend.is_local {
        return Ok(());
    }

    // Only if config_password is set
    let password = match &backend.config_password {
        Some(p) if !p.is_empty() => p.clone(),
        _ => return Ok(()),
    };

    info!("🔓 Auto-unlocking remote config for '{}'...", backend.name);

    let state = app.state::<RcloneState>();
    let url = EndpointHelper::build_url(&backend.api_url(), config::UNLOCK);
    let payload = json!({ "configPassword": password });

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Unlock failed: {}", body));
    }

    app.emit(RCLONE_CONFIG_UNLOCKED, ())
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    info!("✅ Remote config unlocked");
    Ok(())
}

pub async fn ensure_oauth_process(app: &AppHandle) -> Result<(), RcloneError> {
    let state = app.state::<RcloneState>();
    let mut guard = state.oauth_process.lock().await;

    let backend = BACKEND_MANAGER.get_active().await;
    let port = backend
        .oauth_port
        .ok_or_else(|| RcloneError::ConfigError("OAuth not configured".to_string()))?;

    // Check if process is already running (in memory or port open)
    let mut process_running = guard.is_some();
    if !process_running {
        let addr = format!("127.0.0.1:{port}");
        match TcpStream::connect(&addr).await {
            Ok(_) => {
                process_running = true;
                warn!("Rclone OAuth process already running (port {port} in use)",);
            }
            Err(_) => {
                debug!("No existing OAuth process detected on port {port}");
            }
        }
    }

    if process_running {
        return Ok(());
    }

    // Start new process
    let oauth_cmd = match create_rclone_command(port, app, "oauth").await {
        Ok(cmd) => cmd,
        Err(e) => {
            let error_msg = format!("Failed to create OAuth command: {e}");
            return Err(RcloneError::OAuthError(error_msg));
        }
    };

    let (_rx, process) = oauth_cmd.spawn().map_err(|e| {
        let error_msg = format!(
            "Failed to start Rclone OAuth process: {e}. Ensure Rclone is installed and in PATH."
        );
        RcloneError::OAuthError(error_msg)
    })?;

    info!("✅ Rclone OAuth process spawned successfully");

    *guard = Some(process);

    // Wait for process to start with timeout
    let start_time = Instant::now();
    let timeout = Duration::from_secs(5);

    while start_time.elapsed() < timeout {
        if TcpStream::connect(&format!("127.0.0.1:{port}"))
            .await
            .is_ok()
        {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    let timeout_error = format!("Timeout waiting for OAuth process to start on port {port}");
    Err(RcloneError::OAuthError(timeout_error))
}

/// Clean up OAuth process
#[tauri::command]
pub async fn quit_rclone_oauth(state: State<'_, RcloneState>) -> Result<(), String> {
    info!("🛑 Quitting Rclone OAuth process");

    let mut guard = state.oauth_process.lock().await;

    let backend = BACKEND_MANAGER.get_active().await;
    let port = backend.oauth_port.ok_or("OAuth not configured")?;

    let mut found_process = false;

    // Check if process is tracked in memory
    if guard.is_some() {
        found_process = true;
    } else {
        // Try to connect to the port to see if something is running
        let addr = format!("127.0.0.1:{port}");
        if TcpStream::connect(&addr).await.is_ok() {
            found_process = true;
        }
    }

    if !found_process {
        warn!("⚠️ No active Rclone OAuth process found (not in memory, port not open)");
        return Ok(());
    }

    let url = EndpointHelper::build_url(&format!("http://127.0.0.1:{port}"), core::QUIT);

    if let Err(e) = state.client.post(&url).send().await {
        warn!("⚠️ Failed to send quit request: {e}");
    }

    if let Some(process) = guard.take() {
        if let Err(e) = process.kill() {
            error!("❌ Failed to kill process: {e}");
            return Err(format!("Failed to kill process: {e}"));
        } else {
            info!("💀 Rclone OAuth process killed");
        }
    } else {
        // If not tracked, just wait a bit for the process to exit after /core/quit
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    info!("✅ Rclone OAuth process quit successfully");
    Ok(())
}

#[tauri::command]
pub async fn set_bandwidth_limit(
    app: AppHandle,
    rate: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<BandwidthLimitResponse, String> {
    let rate_value = match rate {
        Some(ref s) if s.trim().is_empty() => "off".to_string(),
        Some(s) => s,
        _ => "off".to_string(),
    };

    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), core::BWLIMIT);
    let payload = json!({ "rate": rate_value });

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        return Err(error);
    }

    let response_data: BandwidthLimitResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;

    debug!("🪢 Bandwidth limit set: {response_data:?}");
    if let Err(e) = app.emit(BANDWIDTH_LIMIT_CHANGED, response_data.clone()) {
        error!("❌ Failed to emit bandwidth limit changed event: {e}",);
    }
    Ok(response_data)
}

pub async fn unlock_rclone_config(
    app: AppHandle,
    password: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), config::UNLOCK);

    let payload = json!({ "configPassword": password });

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        return Err(error);
    }

    app.emit(RCLONE_CONFIG_UNLOCKED, ())
        .map_err(|e| format!("Failed to emit config unlocked event: {e}"))?;

    Ok(())
}
