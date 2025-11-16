use log::{error, info, warn};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandChild;

use crate::{
    rclone::state::engine::ENGINE_STATE,
    utils::{
        process::process_manager::{kill_all_rclone_processes, kill_processes_on_port},
        rclone::{
            endpoints::{EndpointHelper, core},
            process_common::create_rclone_command,
        },
        types::all_types::RcApiEngine,
    },
};

impl RcApiEngine {
    pub async fn spawn_process(&mut self, app: &AppHandle) -> Result<CommandChild, String> {
        // Return type is correct
        let port = ENGINE_STATE.get_api().1;
        self.current_api_port = port;

        let engine_app = match create_rclone_command(port, app, "main_engine").await {
            Ok(cmd) => cmd,
            Err(e) => {
                let error_msg = format!("Failed to create engine command: {e}");
                error!("❌ {}", error_msg);
                // Error already emitted by check_binaries if it's a path issue
                return Err(error_msg);
            }
        };

        match engine_app.spawn() {
            // FIX 1: Destructure the tuple returned by spawn().
            // We ignore the receiver (`_rx`) for now and just keep the child process.
            Ok((_rx, child)) => {
                info!("✅ Rclone process spawned successfully");
                self.path_error = false;
                Ok(child)
            }
            Err(e) => {
                error!("❌ Failed to spawn Rclone process: {e}");
                // Check if it's a "file not found" error
                let err_text = e.to_string();
                self.path_error = err_text.contains("No such file or directory")
                    || err_text.contains("os error 2");
                Err(format!("Failed to spawn Rclone process: {e}"))
            }
        }
    }

    pub fn kill_process(&mut self) -> Result<(), String> {
        if let Some(child) = self.process.take() {
            // 1. Attempt graceful shutdown in a background thread
            if self.running {
                info!("🔄 Attempting graceful shutdown...");

                // FIX: Corrected the IP address from 1227.0.0.1 to 127.0.0.1
                let quit_url = EndpointHelper::build_url(
                    &format!("http://127.0.0.1:{}", self.current_api_port),
                    core::QUIT,
                );

                std::thread::spawn(move || {
                    match reqwest::blocking::Client::new()
                        .post(&quit_url)
                        .timeout(Duration::from_secs(2))
                        .send()
                    {
                        Ok(_) => info!("📡 Graceful shutdown request sent"),
                        Err(e) => warn!("⚠️ Graceful shutdown request failed: {e}"),
                    }
                });

                // Give it a moment to shut down gracefully
                std::thread::sleep(Duration::from_secs(2));
            }

            // 2. Force kill the process to ensure it's gone.
            info!("🛑 Force killing process to ensure termination...");
            if let Err(e) = child.kill() {
                let error_msg = format!("Failed to kill process: {e}");
                error!("❌ {}", error_msg);
                return Err(error_msg);
            }
            info!("✅ Process terminated");
        }

        self.running = false;
        Ok(())
    }

    pub fn kill_port_processes(&self) -> Result<(), String> {
        let port = self.current_api_port;
        kill_processes_on_port(port)
    }

    pub fn kill_all_rclone_rcd() -> Result<(), String> {
        kill_all_rclone_processes()
    }
}
