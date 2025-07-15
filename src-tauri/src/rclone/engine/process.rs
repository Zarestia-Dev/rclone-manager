use log::{error, info, warn};
use std::{process::Command, time::Duration};
use tauri::AppHandle;

use crate::{
    rclone::state::ENGINE_STATE,
    utils::{
        process::process_manager::{
            get_child_pid, kill_all_rclone_processes, kill_process_by_pid, kill_processes_on_port,
        },
        rclone::endpoints::{EndpointHelper, core},
        types::all_types::RcApiEngine,
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

        engine_app.args([
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
            error!("❌ Failed to spawn Rclone process: {e}");
            format!("Failed to spawn Rclone process: {e}")
        })
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
