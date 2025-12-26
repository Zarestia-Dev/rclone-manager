use log::error;
use once_cell::sync::Lazy;
use std::sync::{Arc, Mutex};

use crate::utils::types::all_types::RcApiEngine;

pub static ENGINE: Lazy<Arc<Mutex<RcApiEngine>>> =
    Lazy::new(|| Arc::new(Mutex::new(RcApiEngine::default())));

impl Default for RcApiEngine {
    fn default() -> Self {
        Self {
            process: None,
            should_exit: false,
            running: false,
            updating: false,
            path_error: false,
            password_error: false,
            // rclone_path: std::path::PathBuf::new(),
            current_api_port: 51900, // Initialize with default, will be updated by settings
            config_encrypted: None,  // Not determined yet
        }
    }
}

impl RcApiEngine {
    pub fn lock_engine() -> Result<std::sync::MutexGuard<'static, RcApiEngine>, String> {
        match ENGINE.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                error!("❗ Engine mutex poisoned. Recovering...");
                Ok(poisoned.into_inner())
            }
        }
    }
}
