use async_trait::async_trait;
use futures::StreamExt;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::transport::{BackendError, TransportKind};
use crate::rclone::backend::types::Backend;
use crate::rclone::backend::{BackendManager, RcloneTransport};
use crate::utils::types::state::RcloneState;

pub struct RcHttpBackend {
    app: AppHandle,
}

impl RcHttpBackend {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    async fn get_backend_and_client(&self) -> Result<(Backend, reqwest::Client), BackendError> {
        let backend = self
            .app
            .try_state::<BackendManager>()
            .ok_or_else(|| BackendError::NotConnected("BackendManager not in state".into()))?
            .get_active()
            .await;

        let client = self
            .app
            .try_state::<RcloneState>()
            .ok_or_else(|| BackendError::NotConnected("RcloneState not in state".into()))?
            .client
            .clone();

        Ok((backend, client))
    }
}

fn classify_error(endpoint: &str, e: &str) -> BackendError {
    if let Some(rest) = e.strip_prefix("Request failed (HTTP ")
        && let Some(close_paren) = rest.find("): ")
    {
        let status_str = &rest[..close_paren];
        let message = &rest[close_paren + 3..];
        if let Ok(status) = status_str.parse::<u16>() {
            return BackendError::Rpc {
                endpoint: endpoint.to_string(),
                status,
                message: message.to_string(),
            };
        }
    }
    if e.contains("Failed to send request") || e.contains("error sending request") {
        BackendError::NotConnected(e.into())
    } else {
        BackendError::Other(e.into())
    }
}

#[async_trait]
impl RcloneTransport for RcHttpBackend {
    fn kind(&self) -> TransportKind {
        TransportKind::HttpDaemon
    }

    async fn rpc(&self, endpoint: &str, payload: Option<&Value>) -> Result<Value, BackendError> {
        let (backend, client) = self.get_backend_and_client().await?;
        let response = backend
            .make_request(&client, reqwest::Method::POST, endpoint, payload, None)
            .await
            .map_err(|e| classify_error(endpoint, e.as_str()))?;
        response
            .json::<Value>()
            .await
            .map_err(|e| BackendError::Other(format!("Failed to parse response: {e}")))
    }

    async fn rpc_with_timeout(
        &self,
        endpoint: &str,
        payload: Option<&Value>,
        timeout: std::time::Duration,
    ) -> Result<Value, BackendError> {
        let (backend, client) = self.get_backend_and_client().await?;
        let response = backend
            .make_request(
                &client,
                reqwest::Method::POST,
                endpoint,
                payload,
                Some(timeout),
            )
            .await
            .map_err(|e| {
                if e.contains("operation timed out") || e.contains("timed out") {
                    return BackendError::Timeout(timeout);
                }
                classify_error(endpoint, e.as_str())
            })?;
        response
            .json::<Value>()
            .await
            .map_err(|e| BackendError::Other(format!("Failed to parse response: {e}")))
    }

    async fn read_file(
        &self,
        remote: &str,
        path: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, BackendError> {
        let (backend, client) = self.get_backend_and_client().await?;
        let range_header = range.map(|(start, end)| match end {
            Some(e) => format!("bytes={start}-{e}"),
            None => format!("bytes={start}-"),
        });

        // Try standard HTTP streaming first
        match backend
            .fetch_file_stream_with_range(&client, remote, path, range_header.as_deref())
            .await
        {
            Ok(response) if response.status().is_success() => {
                let stream = response
                    .bytes_stream()
                    .map(|result| result.map_err(std::io::Error::other));
                let reader = tokio_util::io::StreamReader::new(stream);
                Ok(Box::new(reader))
            }
            _ => {
                // Fall back to rclone cat via core/command (e.g. for reading local paths on remote daemon hosts)
                let backend_manager = self.app.try_state::<BackendManager>().ok_or_else(|| {
                    BackendError::NotConnected("BackendManager not in state".into())
                })?;
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
    }
}
