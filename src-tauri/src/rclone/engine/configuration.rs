use log::{error, info, warn};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::check_binaries::{is_rclone_available, read_rclone_path},
    utils::types::all_types::RcApiEngine,
};

impl RcApiEngine {
    pub fn get_config_path(&self, app: &AppHandle) -> Option<PathBuf> {
        let app_data_dir = app.path().app_data_dir().ok()?;
        let rclone_config_dir = app_data_dir.join("rclone");
        let rclone_config_file = rclone_config_dir.join("rclone.conf");

        if rclone_config_file.exists() {
            Some(rclone_config_file)
        } else {
            None
        }
    }

    pub fn update_port(&mut self, app: &AppHandle, new_port: u16) {
        info!(
            "🔄 Updating Rclone API port from {} to {}",
            self.current_api_port, new_port
        );

        // Import the stop and start methods from lifecycle module
        if let Err(e) = crate::rclone::engine::lifecycle::stop(self) {
            error!("Failed to stop Rclone process: {e}");
        }
        self.current_api_port = new_port;
        crate::rclone::engine::lifecycle::start(self, app);
    }

    pub fn handle_invalid_path(&mut self, app: &AppHandle) {
        error!(
            "❌ Rclone binary does not exist: {}",
            self.rclone_path.display()
        );

        // Try falling back to system rclone
        if is_rclone_available(app.clone()) {
            info!("🔄 Rclone is available. Getting the path...");
            self.rclone_path = read_rclone_path(app);
        } else {
            warn!("🔄 Waiting for valid Rclone path...");
            if let Err(e) = app.emit(
                "rclone_path_invalid",
                self.rclone_path.to_string_lossy().to_string(),
            ) {
                error!("Failed to emit event: {e}");
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
}
