use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncRead;

use crate::rclone::backend::BackendManager;
use crate::rclone::backend::http_transport::RcHttpBackend;
#[cfg(feature = "librclone")]
use crate::rclone::backend::librclone_transport::RcloneLibBackend;
use crate::rclone::backend::transport::{BackendError, RcloneTransport, TransportKind};

pub struct RoutingTransport {
    app: AppHandle,
    http_transport: RcHttpBackend,
    #[cfg(feature = "librclone")]
    lib_transport: RcloneLibBackend,
}

impl RoutingTransport {
    pub fn new(app: AppHandle) -> Self {
        Self {
            http_transport: RcHttpBackend::new(app.clone()),
            #[cfg(feature = "librclone")]
            lib_transport: RcloneLibBackend::new(app.clone()),
            app,
        }
    }

    #[cfg(feature = "librclone")]
    async fn is_active_local(&self) -> bool {
        if let Some(manager) = self.app.try_state::<BackendManager>() {
            manager.is_active_local().await
        } else {
            true
        }
    }
}

#[async_trait]
impl RcloneTransport for RoutingTransport {
    fn kind(&self) -> TransportKind {
        if cfg!(feature = "librclone") {
            if let Some(manager) = self.app.try_state::<BackendManager>() {
                if manager.try_is_active_local().unwrap_or(true) {
                    TransportKind::Librclone
                } else {
                    TransportKind::HttpDaemon
                }
            } else {
                TransportKind::Librclone
            }
        } else {
            TransportKind::HttpDaemon
        }
    }

    async fn rpc(&self, endpoint: &str, payload: Option<&Value>) -> Result<Value, BackendError> {
        #[cfg(feature = "librclone")]
        {
            if self.is_active_local().await {
                return self.lib_transport.rpc(endpoint, payload).await;
            }
        }
        self.http_transport.rpc(endpoint, payload).await
    }

    async fn rpc_with_timeout(
        &self,
        endpoint: &str,
        payload: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        #[cfg(feature = "librclone")]
        {
            if self.is_active_local().await {
                return self
                    .lib_transport
                    .rpc_with_timeout(endpoint, payload, timeout)
                    .await;
            }
        }
        self.http_transport
            .rpc_with_timeout(endpoint, payload, timeout)
            .await
    }

    async fn read_file(
        &self,
        remote: &str,
        path: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Box<dyn AsyncRead + Unpin + Send>, BackendError> {
        #[cfg(feature = "librclone")]
        {
            if self.is_active_local().await {
                return self.lib_transport.read_file(remote, path, range).await;
            }
        }
        self.http_transport.read_file(remote, path, range).await
    }
}
