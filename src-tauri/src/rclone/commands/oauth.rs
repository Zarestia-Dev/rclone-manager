use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::{Child, Command, Stdio},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use tokio::net::TcpStream;
use tokio::{sync::Mutex, time::sleep};

use crate::{
    core::check_binaries::read_rclone_path,
    rclone::state::ENGINE_STATE,
    utils::{
        rclone::endpoints::{core, EndpointHelper},
        types::{BandwidthLimitResponse, SENSITIVE_KEYS},
    },
    RcloneState,
};

lazy_static::lazy_static! {
    static ref OAUTH_PROCESS: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
}

#[derive(Debug)]
pub enum RcloneError {
    RequestFailed(String),
    ParseError(String),
    JobError(String),
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
            RcloneError::RequestFailed(e) => write!(f, "Request failed: {}", e),
            RcloneError::ParseError(e) => write!(f, "Parse error: {}", e),
            RcloneError::JobError(e) => write!(f, "Job error: {}", e),
            RcloneError::OAuthError(e) => write!(f, "OAuth error: {}", e),
        }
    }
}

pub fn redact_sensitive_values(
    params: &HashMap<String, Value>,
    restrict_mode: &Arc<RwLock<bool>>,
) -> Value {
    params
        .iter()
        .map(|(k, v)| {
            let value = if *restrict_mode.read().unwrap()
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

pub async fn ensure_oauth_process(app: &AppHandle) -> Result<(), RcloneError> {
    let mut guard = OAUTH_PROCESS.lock().await;
    let port = ENGINE_STATE.get_oauth().1;

    // Check if process is already running (in memory or port open)
    let mut process_running = guard.is_some();
    if !process_running {
        let addr = format!("127.0.0.1:{}", port);
        match TcpStream::connect(&addr).await {
            Ok(_) => {
                process_running = true;
                warn!(
                    "Rclone OAuth process already running (port {} in use)",
                    port
                );
            }
            Err(_) => {
                debug!("No existing OAuth process detected on port {}", port);
            }
        }
    }

    if process_running {
        return Ok(());
    }

    // Start new process
    let rclone_path = read_rclone_path(app);

    let mut oauth_app = Command::new(&rclone_path);
    oauth_app
        .args([
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            "--rc-addr",
            &format!("127.0.0.1:{}", port),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // This is a workaround for Windows to avoid showing a console window
    // when starting the Rclone process.
    // It uses the CREATE_NO_WINDOW and DETACHED_PROCESS flags.
    // But it may not work in all cases. Like when app build for terminal
    // and not for GUI. Rclone may still try to open a console window.
    // You can see the flashing of the console window when starting the app.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        oauth_app.creation_flags(0x08000000 | 0x00200000);
    }

    let process = oauth_app.spawn().map_err(|e| {
        RcloneError::OAuthError(format!(
            "Failed to start Rclone OAuth process: {}. Ensure Rclone is installed and in PATH.",
            e
        ))
    })?;

    *guard = Some(process);

    // Wait for process to start with timeout
    let start_time = Instant::now();
    let timeout = Duration::from_secs(5);

    while start_time.elapsed() < timeout {
        if TcpStream::connect(&format!("127.0.0.1:{}", port))
            .await
            .is_ok()
        {
            info!("OAuth process started successfully on port {}", port);
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    Err(RcloneError::OAuthError(format!(
        "Timeout waiting for OAuth process to start on port {}",
        port
    )))
}

/// Clean up OAuth process
#[tauri::command]
pub async fn quit_rclone_oauth(state: State<'_, RcloneState>) -> Result<(), String> {
    info!("🛑 Quitting Rclone OAuth process");

    let mut guard = OAUTH_PROCESS.lock().await;
    let port = ENGINE_STATE.get_oauth().1;
    let mut found_process = false;

    // Check if process is tracked in memory
    if guard.is_some() {
        found_process = true;
    } else {
        // Try to connect to the port to see if something is running
        let addr = format!("127.0.0.1:{}", port);
        if TcpStream::connect(&addr).await.is_ok() {
            found_process = true;
        }
    }

    if !found_process {
        warn!("⚠️ No active Rclone OAuth process found (not in memory, port not open)");
        return Ok(());
    }

    let url = EndpointHelper::build_url(
        &format!("http://127.0.0.1:{}", port),
        core::QUIT
    );

    if let Err(e) = state.client.post(&url).send().await {
        warn!("⚠️ Failed to send quit request: {}", e);
    }

    if let Some(mut process) = guard.take() {
        match process.wait() {
            Ok(status) => {
                info!("✅ Rclone OAuth process exited with status: {:?}", status);
            }
            Err(_) => {
                if let Err(e) = process.kill() {
                    error!("❌ Failed to kill process: {}", e);
                    return Err(format!("Failed to kill process: {}", e));
                }
                info!("💀 Forcefully killed Rclone OAuth process");
            }
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
    _app: AppHandle,
    rate: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<BandwidthLimitResponse, String> {
    let rate_value = match rate {
        Some(ref s) if s.trim().is_empty() => "off".to_string(),
        Some(s) => s,
        _ => "off".to_string(),
    };

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::BWLIMIT);
    let payload = json!({ "rate": rate_value });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        return Err(error);
    }

    let response_data: BandwidthLimitResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    debug!("🪢 Bandwidth limit set: {:?}", response_data);
    Ok(response_data)
}
