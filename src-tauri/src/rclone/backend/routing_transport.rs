use async_trait::async_trait;
use serde_json::Value;
use tauri::AppHandle;
#[cfg(feature = "librclone")]
use tauri::Manager;
use tokio::io::AsyncRead;

#[cfg(feature = "librclone")]
use crate::rclone::backend::BackendManager;
use crate::rclone::backend::http_transport::RcHttpBackend;
#[cfg(feature = "librclone")]
use crate::rclone::backend::librclone_transport::RcloneLibBackend;
use crate::rclone::backend::transport::{BackendError, RcloneTransport, TransportKind};

pub struct RoutingTransport {
    #[cfg(feature = "librclone")]
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
            #[cfg(feature = "librclone")]
            app,
        }
    }

    /// On mobile, route to librclone when the active backend is Local.
    /// On desktop this is statically false and the entire branch is
    /// compiled out.
    #[cfg(feature = "librclone")]
    async fn use_librclone(&self) -> bool {
        if let Some(manager) = self.app.try_state::<BackendManager>() {
            manager.is_active_local().await
        } else {
            // No BackendManager yet (very early startup) — default to
            // librclone since that's the in-process default transport.
            true
        }
    }
}

#[async_trait]
impl RcloneTransport for RoutingTransport {
    async fn kind(&self) -> TransportKind {
        // Desktop: only HTTP exists, return immediately.
        #[cfg(not(feature = "librclone"))]
        {
            return TransportKind::HttpDaemon;
        }

        // Mobile: depends on which backend is active. A user who configured
        // a remote rcd on their phone MUST see HttpDaemon here, otherwise
        // callers like upload.rs would route their bytes through the
        // in-process librclone (which doesn't know about the remote rcd).
        #[cfg(feature = "librclone")]
        {
            if self.use_librclone().await {
                TransportKind::Librclone
            } else {
                TransportKind::HttpDaemon
            }
        }
    }

    async fn rpc(&self, endpoint: &str, payload: Option<&Value>) -> Result<Value, BackendError> {
        #[cfg(feature = "librclone")]
        {
            if self.use_librclone().await {
                return self.lib_transport.rpc(endpoint, payload).await;
            }
        }
        self.http_transport.rpc(endpoint, payload).await
    }

    async fn read_file(
        &self,
        remote: &str,
        path: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Box<dyn AsyncRead + Unpin + Send>, BackendError> {
        #[cfg(feature = "librclone")]
        {
            if self.use_librclone().await {
                return self.lib_transport.read_file(remote, path, range).await;
            }
        }
        self.http_transport.read_file(remote, path, range).await
    }
}
