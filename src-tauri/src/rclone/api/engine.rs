use std::{
    path::PathBuf, process::{Child, Command}, sync::{Arc, Mutex}, thread, time::Duration
};

use once_cell::sync::Lazy;
use reqwest::blocking::Client;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use log::{debug, error, info, warn};

use crate::rclone::api::state::RCLONE_STATE;

pub static ENGINE: Lazy<Arc<Mutex<RcApiEngine>>> =
    Lazy::new(|| Arc::new(Mutex::new(RcApiEngine::default())));

#[derive(Default)]
pub struct RcApiEngine {
    process: Option<Child>,
    should_exit: bool,
    running: bool,
    rclone_path: PathBuf,
    already_reported_invalid_path: bool,
}

impl RcApiEngine {
    pub fn init(&mut self, app: &AppHandle) {
        if self.rclone_path.as_os_str().is_empty() {
            self.rclone_path = self.read_rclone_path(app);
        }

        let app_handle = app.clone();

        thread::spawn(move || loop {
            {
                let mut engine = match RcApiEngine::lock_engine() {
                    Ok(engine) => engine,
                    Err(e) => {
                        error!("❗ Failed to acquire lock on RcApiEngine: {}", e);
                        break;
                    }
                };

                if engine.should_exit {
                    debug!("🛑 Exit requested, stopping monitor thread.");
                    break;
                }

                if !engine.is_running() {
                    if !engine.is_path_valid() {
                        engine.handle_invalid_path(&app_handle);
                        continue;
                    }
                    warn!("🔄 Rclone API not running. Starting...");
                    engine.start(&app_handle);
                } else {
                    debug!("✅ Rclone API running on port {}", RCLONE_STATE.get_api().1);
                }
            }

            thread::sleep(Duration::from_secs(5));
        });
    }

    pub fn lock_engine() -> Result<std::sync::MutexGuard<'static, RcApiEngine>, String> {
        match ENGINE.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                error!("❗ Engine mutex poisoned. Recovering...");
                Ok(poisoned.into_inner())
            }
        }
    }

    fn is_path_valid(&self) -> bool {
        // Check if custom path exists or system rclone is available
        self.rclone_path.exists() || self.is_system_rclone_available()
    }

    fn handle_invalid_path(&mut self, app: &AppHandle) {
        if self.already_reported_invalid_path {
            // Skip re-emitting
            thread::sleep(Duration::from_secs(5));
            return;
        }
        error!(
            "❌ Rclone binary does not exist: {}",
            self.rclone_path.display()
        );

        // Try falling back to system rclone
        if self.is_system_rclone_available() {
            info!("🔄 Falling back to system-installed rclone");
            self.rclone_path = PathBuf::from("rclone");
        } else {
            warn!("🔄 Waiting for valid Rclone path...");
            thread::sleep(Duration::from_secs(5));
            if let Err(e) = app.emit(
                "rclone_path_invalid",
                self.rclone_path.to_string_lossy().to_string(),
            ) {
                error!("Failed to emit event: {}", e);
            }
            self.already_reported_invalid_path = true;
        }
    }

    pub fn update_path(&mut self, app: &AppHandle) {
        self.rclone_path = self.read_rclone_path(app);
        self.already_reported_invalid_path = false;
        info!("🔄 Rclone path updated to: {}", self.rclone_path.display());
        self.start(app);
    }

    pub fn is_running(&self) -> bool {
        let url = format!("{}/config/listremotes", RCLONE_STATE.get_api().0);
        match Client::new().post(&url).send() {
            Ok(resp) => resp.status().is_success(),
            Err(e) => {
                debug!("Failed to check Rclone API status: {}", e);
                false
            }
        }
    }

    pub fn start(&mut self, app: &AppHandle) {
        if self.process.is_some() {
            debug!("⚠️ Rclone process already exists, stopping first...");
            self.stop();
        }

        let port = RCLONE_STATE.get_api().1;

        match Command::new(&self.rclone_path)
            .args(&[
                "rcd",
                "--rc-no-auth",
                "--rc-serve",
                &format!("--rc-addr=127.0.0.1:{}", port),
            ])
            .spawn()
        {
            Ok(child) => {
                if self.wait_until_ready(5) {
                    self.running = true;
                    self.process = Some(child);
                    info!("✅ Rclone API started successfully on port {}", port);
                    if let Err(e) = app.emit("rclone_api_ready", ()) {
                        error!("Failed to emit ready event: {}", e);
                    }
                } else {
                    error!("❌ Failed to start Rclone API within timeout.");
                    if let Err(e) = app.emit(
                        "rclone_api_failed",
                        "Failed to start Rclone API".to_string(),
                    ) {
                        error!("Failed to emit event: {}", e);
                    }
                }
            }
            Err(e) => {
                error!("❌ Failed to spawn Rclone process: {}", e);
                if let Err(e) = app.emit(
                    "rclone_api_failed",
                    "Failed to spawn Rclone process".to_string(),
                ) {
                    error!("Failed to emit event: {}", e);
                }
            }
        }
    }

        fn wait_until_ready(&self, timeout_secs: u64) -> bool {
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_secs);
        let poll = Duration::from_millis(200);

        while start.elapsed() < timeout {
            if self.is_running() {
                return true;
            }
            thread::sleep(poll);
        }

        false
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.process.take() {
            info!("🛑 Killing Rclone process...");
            if let Err(e) = child.kill() {
                error!("❌ Failed to kill Rclone: {}", e);
            }
            let _ = child.wait();
        }

        self.running = false;
    }

    pub fn shutdown(&mut self) {
        self.should_exit = true;
        self.stop();
    }

    fn core_config_path(&self, app: &AppHandle) -> PathBuf {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .expect("Failed to get app data dir");
        app_data_dir.join("core.json")
    }

    fn is_system_rclone_available(&self) -> bool {
        which::which("rclone").is_ok()
    }

    pub fn read_rclone_path(&self, app: &AppHandle) -> PathBuf {
        let config_path = self.core_config_path(app);

        // First try to read the configured path
        let configured_path = match std::fs::read_to_string(&config_path) {
            Ok(contents) => {
                if let Ok(json) = serde_json::from_str::<Value>(&contents) {
                    if let Some(path) = json["core_options"]["rclone_path"].as_str() {
                        if path == "system" {
                            PathBuf::from("rclone") // System-wide installation
                        } else {
                            let bin = if cfg!(windows) {
                                "rclone.exe"
                            } else {
                                "rclone"
                            };
                            PathBuf::from(path).join(bin)
                        }
                    } else {
                        PathBuf::from("rclone") // Default to system-wide
                    }
                } else {
                    PathBuf::from("rclone") // Default to system-wide
                }
            }
            Err(_) => {
                PathBuf::from("rclone") // Default to system-wide
            }
        };

        // Verify the path exists or fallback to system rclone
        if configured_path.exists() {
            configured_path
        } else {
            warn!(
                "⚠️ Configured Rclone path does not exist: {}, falling back to system rclone",
                configured_path.display()
            );

            if self.is_system_rclone_available() {
                info!("🔄 Using system-installed rclone");
                PathBuf::from("rclone")
            } else {
                error!("❌ No valid Rclone binary found - neither configured path nor system rclone available");
                configured_path // Return the original path anyway (will fail later with proper error)
            }
        }
    }
}
