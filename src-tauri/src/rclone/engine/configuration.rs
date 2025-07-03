use std::path::PathBuf;
use log::info;
use tauri::{AppHandle, Manager, Emitter};

use crate::{
    core::check_binaries::is_rclone_available,
    utils::types::RcApiEngine,
    RcloneState,
};

impl RcApiEngine {
    pub fn update_path(&mut self, app: &AppHandle) {
        let rclone_state = app.state::<RcloneState>();
        self.rclone_path = rclone_state.rclone_path.read().unwrap().clone();
        info!("🔄 Rclone path updated to: {}", self.rclone_path.display());
        
        // Import the start method from lifecycle module
        crate::rclone::engine::lifecycle::start(self, app);
    }

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
            log::error!("Failed to stop Rclone process: {}", e);
        }
        self.current_api_port = new_port;
        crate::rclone::engine::lifecycle::start(self, app);
    }

    pub fn handle_invalid_path(&mut self, app: &AppHandle) {
        log::error!(
            "❌ Rclone binary does not exist: {}",
            self.rclone_path.display()
        );

        // Try falling back to system rclone
        if is_rclone_available(app.clone()) {
            info!("🔄 Falling back to system-installed rclone");
            self.rclone_path = PathBuf::from("rclone");
        } else {
            log::warn!("🔄 Waiting for valid Rclone path...");
            if let Err(e) = app.emit(
                "rclone_path_invalid",
                self.rclone_path.to_string_lossy().to_string(),
            ) {
                log::error!("Failed to emit event: {}", e);
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
}
