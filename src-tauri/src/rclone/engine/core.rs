use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::{Mutex, MutexGuard};

use crate::utils::types::all_types::RcApiEngine;

pub static ENGINE: Lazy<Arc<Mutex<RcApiEngine>>> =
    Lazy::new(|| Arc::new(Mutex::new(RcApiEngine::new())));

impl RcApiEngine {
    pub fn new() -> Self {
        Self {
            process: None,
            should_exit: false,
            running: false,
            updating: false,
            path_error: false,
            password_error: false,
            config_encrypted: None,
            api_url: "http://127.0.0.1:51900".to_string(),
            api_port: 51900,
            oauth_url: "http://127.0.0.1:51901".to_string(),
            oauth_port: 51901,
        }
    }

    pub async fn lock_engine() -> MutexGuard<'static, RcApiEngine> {
        ENGINE.lock().await
    }

    /// Get the API URL. Use this instead of ENGINE_STATE.
    pub fn get_api_url(&self) -> String {
        self.api_url.clone()
    }

    /// Get the OAuth URL. Use this instead of ENGINE_STATE.
    pub fn get_oauth_url(&self) -> String {
        self.oauth_url.clone()
    }

    /// Get the OAuth port.
    pub fn get_oauth_port(&self) -> u16 {
        self.oauth_port
    }
}
