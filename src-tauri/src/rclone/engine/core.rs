use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::{Mutex, MutexGuard};

use crate::{rclone::state::engine::ENGINE_STATE, utils::types::all_types::RcApiEngine};

pub static ENGINE: Lazy<Arc<Mutex<RcApiEngine>>> =
    Lazy::new(|| Arc::new(Mutex::new(RcApiEngine::default())));

impl RcApiEngine {
    pub fn default() -> Self {
        Self {
            process: None,
            should_exit: false,
            running: false,
            updating: false,
            path_error: false,
            password_error: false,
            current_api_port: ENGINE_STATE.get_api().1,
            config_encrypted: None,
        }
    }

    pub async fn lock_engine() -> MutexGuard<'static, RcApiEngine> {
        ENGINE.lock().await
    }
}
