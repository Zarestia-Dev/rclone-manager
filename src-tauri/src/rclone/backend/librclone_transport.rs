#![cfg(feature = "librclone")]

use async_trait::async_trait;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::rclone::backend::transport::{BackendError, TransportKind};
use crate::rclone::backend::{BackendManager, RcloneTransport, rclone_ffi};

pub struct RcloneLibBackend {
    app: AppHandle,
}

impl RcloneLibBackend {
    pub fn new(app: AppHandle) -> Self {
        rclone_ffi::initialize();
        log::info!("RcloneLibBackend created");
        let backend = Self { app };
        backend.ensure_default_config_path();
        backend
    }

    fn ensure_default_config_path(&self) {
        if let Ok(paths) = crate::core::paths::AppPaths::from_app_handle(&self.app) {
            use crate::utils::rclone::endpoints::config;
            let conf_path = paths.config_dir.join("rclone.conf");
            let path_str = conf_path.to_string_lossy().to_string();
            let _ = crate::rclone::backend::rclone_ffi::rpc(&serde_json::json!({
                "_path": config::SETPATH,
                "path": path_str
            }));
            log::info!("Set librclone config path to {}", conf_path.display());
        }
    }
}

#[async_trait]
impl RcloneTransport for RcloneLibBackend {
    fn kind(&self) -> TransportKind {
        TransportKind::Librclone
    }

    async fn rpc(&self, endpoint: &str, payload: Option<&Value>) -> Result<Value, BackendError> {
        let mut input = payload
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));

        if let Value::Object(ref mut map) = input {
            map.insert("_path".into(), Value::String(endpoint.to_string()));
        } else {
            let mut wrapper = Map::new();
            wrapper.insert("_path".into(), Value::String(endpoint.to_string()));
            wrapper.insert("input".into(), input);
            input = Value::Object(wrapper);
        }

        let input_clone = input.clone();
        tokio::task::spawn_blocking(move || rclone_ffi::rpc(&input_clone))
            .await
            .map_err(|e| BackendError::Other(format!("librclone FFI join error: {e}")))?
            .map(Ok)?
    }

    async fn read_file(
        &self,
        remote: &str,
        path: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, BackendError> {
        let backend_manager = self
            .app
            .try_state::<BackendManager>()
            .ok_or_else(|| BackendError::NotConnected("BackendManager not in state".into()))?;

        let backend = backend_manager.get_active().await;

        let os = backend_manager.get_runtime_os(&backend.name).await;

        let (offset, count) = range.map_or((None, None), |(start, end)| {
            (Some(start as i64), end.map(|e| (e - start + 1) as i64))
        });

        let bytes = backend
            .fetch_file_via_cat(self, remote, path, offset, count, os)
            .await
            .map_err(BackendError::Other)?;

        Ok(Box::new(std::io::Cursor::new(bytes)))
    }
}
