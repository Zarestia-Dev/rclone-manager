use log::{error, info, warn};
use reqwest::blocking::Client;
use std::{process::Command, time::Duration};
use tauri::AppHandle;

use crate::{
    rclone::state::ENGINE_STATE,
    utils::{
        process::{
            get_child_pid, kill_all_rclone_processes, kill_process_by_pid, kill_processes_on_port,
        },
        rclone::endpoints::{core, EndpointHelper},
        types::RcApiEngine,
    },
};

impl RcApiEngine {
    pub fn spawn_process(&mut self, app: &AppHandle) -> Result<std::process::Child, String> {
        let port = ENGINE_STATE.get_api().1;
        self.current_api_port = port;

        let mut engine_app = Command::new(&self.rclone_path);

        if let Some(config_path) = self.get_config_path(app) {
            engine_app.arg("--config").arg(config_path);
        }

        engine_app.args(&[
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            &format!("--rc-addr=127.0.0.1:{}", self.current_api_port),
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

        engine_app.spawn().map_err(|e| {
            error!("❌ Failed to spawn Rclone process: {}", e);
            format!("Failed to spawn Rclone process: {}", e)
        })
    }

    pub fn kill_process(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.process.take() {
            let quit_url = EndpointHelper::build_url(
                &format!("http://127.0.0.1:{}", self.current_api_port),
                core::QUIT,
            );

            if self.running {
                info!(
                    "🔄 Attempting graceful shutdown of Rclone on port {}...",
                    self.current_api_port
                );

                // Send graceful shutdown request
                let graceful_success = Client::new()
                    .post(&quit_url)
                    .timeout(Duration::from_secs(2))
                    .send()
                    .is_ok();

                if graceful_success {
                    info!("📡 Graceful shutdown request sent, waiting up to 10 seconds...");

                    // Wait up to 10 seconds for graceful shutdown
                    let mut attempts = 0;
                    const MAX_ATTEMPTS: u32 = 20; // 20 attempts * 500ms = 10 seconds

                    while attempts < MAX_ATTEMPTS {
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                info!("✅ Rclone process exited gracefully with status: {status}");
                                self.running = false;
                                return Ok(());
                            }
                            Ok(None) => {
                                // Process is still running, wait a bit more
                                std::thread::sleep(Duration::from_millis(500));
                                attempts += 1;
                            }
                            Err(e) => {
                                warn!("⚠️ Error checking process status: {e}");
                                break;
                            }
                        }
                    }

                    if attempts >= MAX_ATTEMPTS {
                        warn!("⏰ Graceful shutdown timed out after 10 seconds, forcing kill...");
                    }
                } else {
                    warn!("⚠️ Graceful shutdown request failed, proceeding to force kill...");
                }
            }

            // Get the PID before force killing
            if let Some(pid) = get_child_pid(&child) {
                info!(
                    "🛑 Force killing Rclone process {} on port {}...",
                    pid, self.current_api_port
                );

                // Use our robust kill function instead of child.kill()
                match kill_process_by_pid(pid) {
                    Ok(_) => info!("✅ Successfully killed Rclone process {}", pid),
                    Err(e) => {
                        warn!("⚠️ Robust kill failed, trying fallback method: {}", e);
                        // Fallback to standard kill if our robust method fails
                        if let Err(e) = child.kill() {
                            error!("❌ Fallback kill also failed: {}", e);
                            return Err(format!("Failed to kill Rclone process: {}", e));
                        }
                    }
                }
            } else {
                // Fallback if we can't get PID
                if let Err(e) = child.kill() {
                    error!("❌ Failed to kill Rclone: {}", e);
                    return Err(format!("Failed to kill Rclone process: {}", e));
                }
            }

            let _ = child.wait();
        }

        info!("✅ Rclone process stopped.");
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
