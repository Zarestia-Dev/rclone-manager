use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use log::{debug, error, info, warn};

use once_cell::sync::Lazy;
use reqwest::blocking::Client;
use serde_json::Value;
use std::sync::RwLock;
use tauri::{AppHandle, Emitter, Manager};

use crate::rclone::api::state::get_rclone_api_port_global;

use super::state::get_rclone_api_url_global;

pub static RCLONE_PATH: Lazy<RwLock<String>> = Lazy::new(|| RwLock::new("rclone".to_string()));

static HTTP_CLIENT: Lazy<Client> = Lazy::new(Client::new);
static LAST_KNOWN_STATE: Lazy<RwLock<bool>> = Lazy::new(|| RwLock::new(false));

pub fn is_rc_api_running() -> bool {
    let url = format!("{}/config/listremotes", get_rclone_api_url_global());

    let new_state = match HTTP_CLIENT.post(&url).send() {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    };

    let mut last_state = LAST_KNOWN_STATE.write().unwrap();
    if *last_state != new_state {
        *last_state = new_state; // Update state
        if new_state {
            info!("✅ Rclone API is back online!");
        } else {
            warn!("⚠️ Rclone API is down!");
        }
    }

    new_state
}

pub fn set_rclone_path(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app
        .path()
        .app_data_dir()
        .expect("Failed to get app data directory");

    let settings_path = config_dir.join("core.json");

    // Read file content
    let contents = fs::read_to_string(&settings_path).map_err(|_| "Failed to read core.json")?;

    // Parse JSON
    let json: Value = serde_json::from_str(&contents).map_err(|_| "Failed to parse JSON")?;

    // Extract Rclone path
    let rclone_path = json["core_options"]["rclone_path"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("rclone"));

    let final_path = if rclone_path == Path::new("system") {
        "rclone".to_string()
    } else {
        let binary_name = if cfg!(target_os = "windows") {
            "rclone.exe"
        } else {
            "rclone"
        };
        rclone_path.join(binary_name).to_string_lossy().to_string()
    };

    // Update the global RCLONE_PATH
    let mut rclone_path_lock = RCLONE_PATH.write().unwrap();
    *rclone_path_lock = final_path;

    debug!("✅ Rclone path set to: {}", *rclone_path_lock);
    Ok(())
}

pub fn start_rc_api() -> Result<Child, Box<dyn Error>> {
    info!(
        "🚀 Starting Rclone RC API on port {}",
        get_rclone_api_port_global()
    );

    // Retrieve the stored custom installation path
    let rclone_path = {
        let rclone_path = RCLONE_PATH.read().unwrap();
        if rclone_path.is_empty() {
            return Err("Rclone path is not set.".into());
        }
        rclone_path.clone()
    };

    let child = Command::new(rclone_path)
        .args(&[
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            &format!("--rc-addr=localhost:{}", get_rclone_api_port_global()),
        ])
        .spawn()
        .map_err(|e| {
            error!("❌ Failed to start Rclone RC API: {}", e);
            e
        })?;

    // Wait for the process to start
    thread::sleep(Duration::from_secs(2));

    debug!("✅ Rclone RC API started with PID: {:?}", child.id());
    Ok(child)
}

pub fn stop_rc_api(rc_process: &mut Option<Child>) {
    debug!("🔄 Attempting to stop Rclone RCD process...");

    if let Some(mut child) = rc_process.take() {
        // First try to kill the process
        if let Err(e) = child.kill() {
            warn!("Failed to kill Rclone process: {}", e);
        } else {
            info!("Rclone process kill signal sent successfully.");
        }

        // Always wait for the process to clean up resources
        match child.wait() {
            Ok(status) => debug!("✅ Rclone process exited with status: {:?}", status),
            Err(e) => warn!("⚠️ Failed to wait for Rclone process: {}", e),
        }
    }
}

pub fn ensure_rc_api_running(app: tauri::AppHandle, rc_process: Arc<Mutex<Option<Child>>>) {
    info!(
        "🔧 Ensuring Rclone RC API is running on port {}",
        get_rclone_api_port_global()
    );

    let rc_process_clone: Arc<Mutex<Option<Child>>> = rc_process.clone();
    let app_clone = app.clone();

    thread::spawn(move || {
        loop {
            {
                let mut process_guard = rc_process_clone.lock().unwrap();

                if !is_rc_api_running() {
                    warn!("⚠️ Rclone API is not running. Restarting...");

                    // Stop any existing Rclone instance before starting a new one
                    if process_guard.is_some() {
                        warn!("🛑 Stopping previous Rclone instance...");
                        stop_rc_api(&mut process_guard);
                    }

                    match start_rc_api() {
                        Ok(child) => {
                            app_clone
                                .emit("rclone_api_started", get_rclone_api_url_global())
                                .unwrap();
                            *process_guard = Some(child);
                        }
                        Err(e) => {
                            error!("🚨 Failed to start Rclone RC API: {}", e);
                        }
                    }
                } else {
                    debug!(
                        "✅ Rclone API is running on port {}",
                        get_rclone_api_port_global()
                    );
                }
            }
            thread::sleep(Duration::from_secs(10)); // Adjust as needed
        }
    });
}
