use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
use tokio::io::AsyncRead;

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("rclone RPC failed: {endpoint} -> HTTP {status}: {message}")]
    Rpc {
        endpoint: String,
        status: u16,
        message: String,
    },

    #[error("transport not connected: {0}")]
    NotConnected(String),

    #[error("transport timeout after {0:?}")]
    Timeout(Duration),

    #[error("stream read error: {0}")]
    Stream(String),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),
}

impl BackendError {
    pub fn status_code(&self) -> Option<u16> {
        match self {
            BackendError::Rpc { status, .. } => Some(*status),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    HttpDaemon,
    Librclone,
}

#[async_trait]
pub trait RcloneTransport: Send + Sync {
    async fn kind(&self) -> TransportKind;

    /// Bind file metadata and all subsequent reads to one backend. Fixed
    /// transports return None; the routing transport captures its current target.
    async fn for_file_read(
        &self,
    ) -> Result<Option<std::sync::Arc<dyn RcloneTransport>>, BackendError> {
        Ok(None)
    }

    async fn rpc(&self, endpoint: &str, payload: Option<&Value>) -> Result<Value, BackendError>;

    /// Open a pull-driven reader when the backend supports a real stream.
    /// Buffered RPC transports fall back to bounded read_file calls.
    async fn open_file_stream(
        &self,
        _remote: &str,
        _path: &str,
        _range: (u64, u64),
    ) -> Result<Option<Box<dyn AsyncRead + Unpin + Send>>, BackendError> {
        Ok(None)
    }

    async fn rpc_with_timeout(
        &self,
        endpoint: &str,
        payload: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        match tokio::time::timeout(timeout, self.rpc(endpoint, payload)).await {
            Ok(result) => result,
            Err(_) => Err(BackendError::Timeout(timeout)),
        }
    }

    async fn read_file(
        &self,
        remote: &str,
        path: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Box<dyn AsyncRead + Unpin + Send>, BackendError>;
}
