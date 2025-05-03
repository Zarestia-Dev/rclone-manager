use std::{
    path::PathBuf,
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use once_cell::sync::Lazy;
use reqwest::blocking::Client;
use tauri::{AppHandle, Emitter};

use log::{debug, error, info, warn};

use crate::{
    core::check_binaries::{is_rclone_available, read_rclone_path},
    rclone::api::state::RCLONE_STATE,
};

pub static ENGINE: Lazy<Arc<Mutex<RcApiEngine>>> =
    Lazy::new(|| Arc::new(Mutex::new(RcApiEngine::default())));

#[derive(Default)]
pub struct RcApiEngine {
    process: Option<Child>,
    should_exit: bool,
    running: bool,
    rclone_path: PathBuf,
    current_api_port: u16,
    already_reported_invalid_path: bool,
}

impl RcApiEngine {
    fn default() -> Self {
        Self {
            process: None,
            should_exit: false,
            running: false,
            rclone_path: PathBuf::new(),
            already_reported_invalid_path: false,
            current_api_port: RCLONE_STATE.get_api().1, // Initialize with current port
        }
    }

    pub fn init(&mut self, app: &AppHandle) {
        if self.rclone_path.as_os_str().is_empty() {
            self.rclone_path = read_rclone_path(app);
        }

        let app_handle = app.clone();

        self.start(app);

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
                    if !(engine.rclone_path.exists() || is_rclone_available(app_handle.clone())) {
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
        if is_rclone_available(app.clone()) {
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
        self.rclone_path = read_rclone_path(app);
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

    pub fn update_port(&mut self, app: &AppHandle, new_port: u16) {
        info!(
            "🔄 Updating Rclone API port from {} to {}",
            self.current_api_port, new_port
        );
        self.stop();
        self.current_api_port = new_port;
        self.start(app);
    }

    pub fn start(&mut self, app: &AppHandle) {
        if self.process.is_some() {
            debug!("⚠️ Rclone process already exists, stopping first...");
            self.stop();
        }

        let port = RCLONE_STATE.get_api().1;
        self.current_api_port = port;

        let mut engine_app = Command::new(&self.rclone_path);

        engine_app.args(&[
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            &format!("--rc-addr=127.0.0.1:{}", port),
        ]);


        // This is a workaround for Windows to avoid showing a console window
        // when starting the Rclone process.
        // It uses the CREATE_NO_WINDOW and DETACHED_PROCESS flags.
        // But it may not work in all cases. Like when app build for terminal
        // and not for GUI. Rclone may still try to open a console window.
        // You can see the flashing of the console window when starting the app.
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            engine_app.creation_flags(0x08000000 | 0x00200000);
        }

        match engine_app.spawn() {
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
            let quit_url = format!("http://127.0.0.1:{}/core/quit", self.current_api_port);

            if self.running {
                info!(
                    "🔄 Attempting graceful shutdown of Rclone on port {}...",
                    self.current_api_port
                );
                if let Ok(_) = Client::new().post(&quit_url).send() {
                    // Wait a bit for graceful shutdown
                    thread::sleep(Duration::from_secs(1));
                }
            }

            // Force kill if still running
            info!(
                "🛑 Killing Rclone process on port {}...",
                self.current_api_port
            );
            if let Err(e) = child.kill() {
                error!("❌ Failed to kill Rclone: {}", e);
            }
            let _ = child.wait();
            self.running = false;
        }
    }

    pub fn shutdown(&mut self) {
        info!("🛑 Shutting down Rclone engine...");
        self.should_exit = true;
        self.stop();
    }
}
