use std::{
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use once_cell::sync::Lazy;
use reqwest::blocking::Client;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use log::{debug, error, info, warn};

use crate::rclone::api::state::RCLONE_STATE;

pub static ENGINE: Lazy<Arc<Mutex<RcApiEngine>>> =
    Lazy::new(|| Arc::new(Mutex::new(RcApiEngine::default())));

#[derive(Default)]
pub struct RcApiEngine {
    process: Option<Child>,
    should_exit: bool,
    running: bool,
    rclone_path: String,
}

impl RcApiEngine {
    pub fn init(&mut self, app: &AppHandle) {
        if self.rclone_path.is_empty() {
            self.rclone_path = Self::read_rclone_path(app);
        }

        let app_handle = app.clone();
        let engine_arc = ENGINE.clone();

        thread::spawn(move || loop {
            {
                let mut engine = engine_arc.lock().unwrap();

                if engine.should_exit {
                    debug!("🛑 Exit requested, stopping monitor thread.");
                    break;
                }

                if !engine.is_running() {
                    warn!("🔄 Rclone API not running. Starting...");
                    engine.start(&app_handle);
                } else {
                    debug!("✅ Rclone API running on port {}", RCLONE_STATE.get_api().1);
                }
            }

            thread::sleep(Duration::from_secs(5));
        });
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

    pub fn start(&mut self, _app: &AppHandle) {
        if self.process.is_some() {
            debug!("⚠️ Rclone process already exists, stopping first...");
            self.stop();
        }

        let port = RCLONE_STATE.get_api().1;
        let path = &self.rclone_path;

        match Command::new(path)
            .args(&[
                "rcd",
                "--rc-no-auth",
                "--rc-serve",
                &format!("--rc-addr=127.0.0.1:{}", port),
            ])
            .spawn()
        {
            Ok(child) => {
                self.process = Some(child);
                self.running = true;
                info!("✅ Rclone RC API started process on port {}", port);
            }
            Err(e) => {
                error!("❌ Failed to start Rclone: {}", e);
                self.running = false;
            }
        }
    }

    pub fn wait_until_ready(&self, timeout_secs: u64) -> bool {
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_secs);
        let poll = Duration::from_millis(200);

        while start.elapsed() < timeout {
            if self.is_running() {
                return true;
            }
            std::thread::sleep(poll);
        }

        false
    }

    pub fn start_and_wait(&mut self, app: &AppHandle, timeout_secs: u64) -> bool {
        self.start(app);
        info!(
            "⏳ Waiting up to {}s for Rclone API to become ready...",
            timeout_secs
        );
        self.wait_until_ready(timeout_secs)
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

    pub fn read_rclone_path(app: &AppHandle) -> String {
        let config_path = app
            .path()
            .app_data_dir()
            .expect("Failed to get app data dir")
            .join("core.json");

        match std::fs::read_to_string(&config_path) {
            Ok(contents) => {
                if let Ok(json) = serde_json::from_str::<Value>(&contents) {
                    if let Some(path) = json["core_options"]["rclone_path"].as_str() {
                        return if path == "system" {
                            "rclone".to_string()
                        } else {
                            let bin = if cfg!(windows) {
                                "rclone.exe"
                            } else {
                                "rclone"
                            };
                            format!("{}/{}", path, bin)
                        };
                    }
                }
                "rclone".to_string()
            }
            Err(e) => {
                warn!("Could not read rclone path from config: {}", e);
                "rclone".to_string()
            }
        }
    }
}
