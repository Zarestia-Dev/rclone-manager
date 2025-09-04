use log::{error, info, warn};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::{
    rclone::state::ENGINE_STATE,
    utils::{
        process::process_manager::{
            get_child_pid, kill_all_rclone_processes, kill_process_by_pid, kill_processes_on_port,
        },
        rclone::{
            endpoints::{EndpointHelper, core},
            process_common::{create_rclone_command, spawn_stderr_monitor},
        },
        types::all_types::RcApiEngine,
    },
};

impl RcApiEngine {
    pub fn spawn_process(&mut self, app: &AppHandle) -> Result<std::process::Child, String> {
        let port = ENGINE_STATE.get_api().1;
        self.current_api_port = port;

        let mut engine_app =
            match create_rclone_command(self.rclone_path.to_str().unwrap(), port, app, "Engine") {
                Ok(cmd) => cmd,
                Err(e) => {
                    let error_msg = format!("Failed to create engine command: {e}");
                    error!("❌ {}", error_msg);
                    let _ = app.emit(
                        "rclone_engine",
                        serde_json::json!({
                            "status": "error",
                            "message": error_msg,
                            "error_type": "spawn_failed"
                        }),
                    );
                    return Err(error_msg);
                }
            };

        // Override stdout for the main engine to capture output
        engine_app.stdout(std::process::Stdio::piped());

        match engine_app.spawn() {
            Ok(child) => {
                info!("✅ Rclone process spawned successfully");

                // Start monitoring stderr using shared utility
                let monitored_child =
                    spawn_stderr_monitor(child, app.clone(), "rclone_engine", "Engine");

                Ok(monitored_child)
            }
            Err(e) => {
                error!("❌ Failed to spawn Rclone process: {e}");
                // Emit spawn error event
                let _ = app.emit(
                    "rclone_engine",
                    serde_json::json!({
                        "status": "error",
                        "message": format!("Failed to spawn Rclone process: {e}"),
                        "error_type": "spawn_failed"
                    }),
                );
                Err(format!("Failed to spawn Rclone process: {e}"))
            }
        }
    }

    pub fn kill_process(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.process.take() {
            let graceful_result = std::thread::scope(|s| {
                let join_result = s
                    .spawn(|| {
                        let quit_url = EndpointHelper::build_url(
                            &format!("http://127.0.0.1:{}", self.current_api_port),
                            core::QUIT,
                        );

                        if self.running {
                            info!("🔄 Attempting graceful shutdown...");
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
                const MAX_ATTEMPTS: u32 = 20;

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

    pub fn kill_port_processes(&self) -> Result<(), String> {
        let port = self.current_api_port;
        kill_processes_on_port(port)
    }

    pub fn kill_all_rclone_rcd() -> Result<(), String> {
        kill_all_rclone_processes()
    }
}
