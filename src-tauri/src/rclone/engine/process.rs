use log::{error, info, warn};
use std::{process::Command, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::security::{CredentialStore, SafeEnvironmentManager},
    rclone::state::ENGINE_STATE,
    utils::{
        process::process_manager::{
            get_child_pid, kill_all_rclone_processes, kill_process_by_pid, kill_processes_on_port,
        },
        rclone::endpoints::{core, EndpointHelper},
        types::all_types::RcApiEngine,
    },
};

impl RcApiEngine {
    /// Check if a stderr line indicates a password error
    fn is_password_error(line: &str) -> bool {
        let password_error_patterns = [
            "most likely wrong password",
            "Couldn't decrypt configuration",
            "Enter configuration password",
            "Failed to read line: EOF",
            "password required",
            "configuration is encrypted",
        ];
        
        let line_lower = line.to_lowercase();
        password_error_patterns
            .iter()
            .any(|pattern| line_lower.contains(&pattern.to_lowercase()))
    }

    pub fn spawn_process(&mut self, app: &AppHandle) -> Result<std::process::Child, String> {
        let port = ENGINE_STATE.get_api().1;
        self.current_api_port = port;

        let mut engine_app = Command::new(&self.rclone_path);

        // Check if we have a stored password and set it in environment manager
        let credential_store = CredentialStore::new();
        if let Ok(password) = credential_store.get_config_password() {
            info!("🔑 Using stored rclone config password");
            // Get the SafeEnvironmentManager from app state
            if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
                env_manager.set_config_password(password);
            } else {
                warn!("⚠️ SafeEnvironmentManager not available in app state");
            }
        } else {
            info!("ℹ️ No stored password found, rclone will prompt if needed");
            // Emit event to UI that password might be needed
            let _ = app.emit("rclone_engine", serde_json::json!("config_password_required"));
        }

        // if let Some(config_path) = self.get_config_path(app) {
        //     engine_app.arg("--config").arg(config_path);
        // }

        engine_app.args([
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            &format!("--rc-addr=127.0.0.1:{}", self.current_api_port),
        ]);

        // Set rclone environment variables from our safe manager
        if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
            let env_vars = env_manager.get_env_vars();
            for (key, value) in env_vars {
                engine_app.env(key, value);
            }
        }

        // Capture stderr to detect password errors
        engine_app.stderr(std::process::Stdio::piped());
        engine_app.stdout(std::process::Stdio::piped());

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
            Ok(mut child) => {
                info!("✅ Rclone process spawned successfully");
                
                // Start monitoring stderr for password errors in a separate thread
                if let Some(stderr) = child.stderr.take() {
                    let app_handle = app.clone();
                    std::thread::spawn(move || {
                        use std::io::{BufRead, BufReader};
                        use std::time::{Duration, Instant};
                        
                        let reader = BufReader::new(stderr);
                        let start_time = Instant::now();
                        let monitor_timeout = Duration::from_secs(30); // Monitor stderr for 30 seconds max
                        
                        for line in reader.lines().map_while(Result::ok) {
                            // Stop monitoring after timeout to prevent resource leaks
                            if start_time.elapsed() > monitor_timeout {
                                info!("⏰ Stopping stderr monitoring after timeout");
                                break;
                            }
                            
                            error!("🔍 Rclone stderr: {}", line);
                            
                            // Check for password errors
                            if Self::is_password_error(&line) {
                                error!("🔑 Password error detected: {}", line);
                                
                                // Clear the wrong password from storage
                                let credential_store = CredentialStore::new();
                                if let Err(e) = credential_store.remove_config_password() {
                                    warn!("⚠️ Failed to clear wrong password from storage: {}", e);
                                } else {
                                    info!("🧹 Cleared wrong password from storage");
                                }
                                
                                // Clear from environment manager too
                                if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
                                    env_manager.clear_config_password();
                                    info!("🧹 Cleared password from environment manager");
                                }
                                
                                // Emit password error event to frontend
                                let _ = app_handle.emit("rclone_engine", serde_json::json!({
                                    "status": "error",
                                    "message": line,
                                    "error_type": "password_required"
                                }));
                                
                                // Break after detecting password error to avoid spam
                                break;
                            }
                        }
                    });
                }
                
                Ok(child)
            }
            Err(e) => {
                error!("❌ Failed to spawn Rclone process: {e}");
                Err(format!("Failed to spawn Rclone process: {e}"))
            }
        }
    }

    pub fn kill_process(&mut self) -> Result<(), String> {
        // Move the process out of self so we own it
        if let Some(mut child) = self.process.take() {
            // First try graceful shutdown
            let graceful_result = std::thread::scope(|s| {
                let join_result = s
                    .spawn(|| {
                        let quit_url = EndpointHelper::build_url(
                            &format!("http://127.0.0.1:{}", self.current_api_port),
                            core::QUIT,
                        );

                        if self.running {
                            info!("🔄 Attempting graceful shutdown...");

                            // Use blocking client in a separate thread
                            match reqwest::blocking::Client::new()
                                .post(&quit_url)
                                .timeout(Duration::from_secs(2))
                                .send()
                            {
                                Ok(_) => info!("📡 Graceful shutdown request sent"),
                                Err(e) => warn!("⚠️ Graceful shutdown request failed: {e}"),
                            }
                        }
                    })
                    .join();

                if let Err(e) = join_result {
                    warn!("⚠️ Thread panicked during graceful shutdown: {e:?}");
                }

                // Wait for process to exit
                let mut attempts = 0;
                const MAX_ATTEMPTS: u32 = 20; // 10 seconds total

                while attempts < MAX_ATTEMPTS {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            info!("✅ Process exited with status: {status}");
                            return Ok(());
                        }
                        Ok(_) => {
                            std::thread::sleep(Duration::from_millis(500));
                            attempts += 1;
                        }
                        Err(e) => {
                            warn!("⚠️ Error checking process status: {e}");
                            break;
                        }
                    }
                }

                Err("Graceful shutdown timed out".to_string())
            });

            if graceful_result.is_err() {
                // Force kill if graceful failed
                if let Some(pid) = get_child_pid(&child) {
                    info!("🛑 Force killing process {pid}...");
                    kill_process_by_pid(pid)?;
                } else if let Err(e) = child.kill() {
                    error!("❌ Failed to kill process: {e}");
                    return Err(format!("Failed to kill process: {e}"));
                }
                let _ = child.wait();
            }
        }

        self.running = false;
        Ok(())
    }
    /// Kill any processes using our API port (including orphaned ones)
    pub fn kill_port_processes(&self) -> Result<(), String> {
        let port = self.current_api_port;
        kill_processes_on_port(port)
    }

    /// Kill all rclone rcd processes (emergency cleanup)
    pub fn kill_all_rclone_rcd() -> Result<(), String> {
        kill_all_rclone_processes()
    }
}
