use crate::context::AppHandle;
use crate::utils::io::file_stream::{
    FILE_CHUNK_SIZE, decode_file_chunk, file_location, file_metadata, file_reader,
};
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::rclone::backend::transport::{BackendError, TransportKind};
use crate::rclone::backend::types::Backend;
use crate::rclone::backend::{BackendManager, RcloneTransport};
use crate::utils::types::state::RcloneState;

pub struct RcHttpBackend {
    app: AppHandle,
    backend: Option<Backend>,
    direct_reads: AtomicBool,
}

impl RcHttpBackend {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            backend: None,
            direct_reads: AtomicBool::new(true),
        }
    }

    pub fn for_backend(&self, backend: Backend) -> Self {
        Self {
            app: self.app.clone(),
            backend: Some(backend),
            direct_reads: AtomicBool::new(true),
        }
    }

    async fn get_backend_and_client(&self) -> Result<(Backend, reqwest::Client), BackendError> {
        let backend = match &self.backend {
            Some(backend) => backend.clone(),
            None => {
                self.app
                    .try_state::<BackendManager>()
                    .ok_or_else(|| {
                        BackendError::NotConnected("BackendManager not in state".into())
                    })?
                    .get_active()
                    .await
            }
        };

        let client = self
            .app
            .try_state::<RcloneState>()
            .ok_or_else(|| BackendError::NotConnected("RcloneState not in state".into()))?
            .client
            .clone();

        Ok((backend, client))
    }
}

#[async_trait]
impl RcloneTransport for RcHttpBackend {
    async fn kind(&self) -> TransportKind {
        TransportKind::HttpDaemon
    }

    fn shares_host_filesystem(&self) -> bool {
        self.backend.as_ref().is_none_or(|backend| backend.is_local)
    }

    async fn open_file_stream(
        &self,
        remote: &str,
        path: &str,
        range: (u64, u64),
    ) -> Result<Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, BackendError> {
        if self.backend.is_some() && !self.direct_reads.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let (backend, client) = self.get_backend_and_client().await?;
        let header = format!("bytes={}-{}", range.0, range.1);
        let response = match backend
            .fetch_file_stream_with_range(&client, remote, path, Some(&header))
            .await
        {
            Ok(response) if matches_file_range(&response, Some((range.0, Some(range.1)))) => {
                response
            }
            _ => {
                self.direct_reads.store(false, Ordering::Relaxed);
                return Ok(None);
            }
        };
        let stream = response
            .bytes_stream()
            .map(|result| result.map_err(std::io::Error::other));
        Ok(Some(Box::new(tokio_util::io::StreamReader::new(stream))))
    }

    async fn rpc(&self, endpoint: &str, payload: Option<&Value>) -> Result<Value, BackendError> {
        let (backend, client) = self.get_backend_and_client().await?;
        let response = backend
            .make_request(&client, reqwest::Method::POST, endpoint, payload, None)
            .await?;
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

        // A pinned file operation remembers a failed direct-stream probe.
        // Dynamic transports retry because their active backend can change.
        let response = if self.backend.is_none() || self.direct_reads.load(Ordering::Relaxed) {
            backend
                .fetch_file_stream_with_range(&client, remote, path, range_header.as_deref())
                .await
                .ok()
        } else {
            None
        };
        match response {
            Some(response) if matches_file_range(&response, range) => {
                let stream = response
                    .bytes_stream()
                    .map(|result| result.map_err(std::io::Error::other));
                let reader = tokio_util::io::StreamReader::new(stream);
                Ok(Box::new(reader))
            }
            _ => {
                self.direct_reads.store(false, Ordering::Relaxed);
                // Read through operations/getfile, which also reaches local paths on a
                // daemon running on another machine
                let count = match range {
                    Some((start, Some(end))) => Some(
                        end.checked_sub(start)
                            .and_then(|count| count.checked_add(1))
                            .ok_or_else(|| BackendError::Stream("Invalid file range".into()))?,
                    ),
                    _ => None,
                };
                if count.is_none_or(|count| count > FILE_CHUNK_SIZE) {
                    let start = range.map_or(0, |(start, _)| start);
                    i64::try_from(start).map_err(|e| BackendError::Stream(e.to_string()))?;
                    let pinned = self.for_backend(backend);
                    pinned.direct_reads.store(false, Ordering::Relaxed);
                    let transport: std::sync::Arc<dyn RcloneTransport> =
                        std::sync::Arc::new(pinned);
                    let version = file_metadata(transport.as_ref(), remote, path).await?;
                    let length = version
                        .size
                        .saturating_sub(start)
                        .min(count.unwrap_or(u64::MAX));
                    return Ok(Box::new(file_reader(
                        transport,
                        remote.to_owned(),
                        path.to_owned(),
                        start,
                        length,
                        Some(version),
                    )));
                }
                let count = count
                    .ok_or_else(|| BackendError::Stream("Missing bounded file range".into()))?;
                let (fs, file) = file_location(remote, path);
                let offset = range.map_or(0, |(start, _)| start);
                let payload = serde_json::json!({
                    "fs": fs, "remote": file, "offset": offset, "count": count, "base64": true,
                });
                let response: Value = backend
                    .make_request(
                        &client,
                        reqwest::Method::POST,
                        crate::rclone::endpoints::operations::GETFILE,
                        Some(&payload),
                        None,
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|e| BackendError::Other(format!("Failed to parse response: {e}")))?;
                let bytes = decode_file_chunk(&response, count)?;

                Ok(Box::new(std::io::Cursor::new(bytes)))
            }
        }
    }
}

/// A server may ignore Range and return 200. Never label those bytes as a later
/// file segment: use the offset-aware fallback instead.
fn matches_file_range(response: &reqwest::Response, range: Option<(u64, Option<u64>)>) -> bool {
    let Some((start, end)) = range else {
        return response.status() == reqwest::StatusCode::OK;
    };
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return false;
    }
    let Some(value) = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some((bounds, total)) = value.strip_prefix("bytes ").and_then(|v| v.split_once('/')) else {
        return false;
    };
    let Some((actual_start, Some(actual_end))) =
        crate::utils::io::http_helpers::parse_byte_range(&format!("bytes={bounds}"))
    else {
        return false;
    };
    let total = if total == "*" {
        None
    } else {
        let Ok(total) = total.parse::<u64>() else {
            return false;
        };
        if total <= actual_end {
            return false;
        }
        Some(total)
    };
    actual_start == start
        && end.is_none_or(|end| actual_end == total.map_or(end, |total| end.min(total - 1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    fn test_transport(port: u16) -> RcHttpBackend {
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        app.manage(RcloneState::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap(),
            std::sync::Arc::new(RcHttpBackend::new(app.clone())),
        ));
        let backend = Backend::new_remote("test", "127.0.0.1", port);
        let dynamic = RcHttpBackend::new(app);
        dynamic.for_backend(backend)
    }

    #[test]
    fn only_the_app_managed_daemon_shares_the_host_filesystem() {
        let transport = RcHttpBackend::new(AppHandle::default());
        assert!(transport.shares_host_filesystem());
        for (is_local, expected) in [(true, true), (false, false)] {
            let backend = Backend {
                is_local,
                ..Backend::default()
            };
            assert_eq!(
                transport.for_backend(backend).shares_host_filesystem(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn unsupported_direct_stream_is_probed_once_per_file_operation() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = crate::utils::spawn(async move {
            let mut methods = vec![];
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
                }
                let method = String::from_utf8(request)
                    .unwrap()
                    .split_ascii_whitespace()
                    .next()
                    .unwrap()
                    .to_owned();
                let response: &[u8] = if method == "GET" {
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\nConnection: close\r\n\r\n{\"result\":\"YWJj\"}"
                };
                socket.write_all(response).await.unwrap();
                methods.push(method);
            }
            methods
        });
        let pinned = test_transport(port);
        assert!(
            pinned
                .open_file_stream("drive:", "file", (0, 5))
                .await
                .unwrap()
                .is_none()
        );
        for start in [0, 3] {
            let mut reader = pinned
                .read_file("drive:", "file", Some((start, Some(start + 2))))
                .await
                .unwrap();
            let mut bytes = vec![];
            reader.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, b"abc");
        }
        assert!(
            test_transport(port)
                .open_file_stream("drive:", "file", (0, 5))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(requests.await.unwrap(), ["GET", "POST", "POST", "GET"]);
    }
    #[tokio::test]
    async fn unbounded_getfile_fallback_returns_a_lazy_chunked_reader() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = crate::utils::spawn(async move {
            let mut paths = vec![];
            for _ in 0..5 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
                }
                let request = String::from_utf8(request).unwrap();
                let path = request.split_ascii_whitespace().nth(1).unwrap().to_owned();
                let (status, body) = if request.starts_with("GET ") {
                    ("404 Not Found", "")
                } else if path.ends_with("operations/stat") {
                    ("200 OK", r#"{"item":{"Size":6,"ModTime":"stable"}}"#)
                } else {
                    ("200 OK", r#"{"result":"YWJjMTIz"}"#)
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                paths.push(path);
            }
            paths
        });
        let transport = test_transport(port);
        let mut reader = transport.read_file("drive:", "file", None).await.unwrap();
        let mut bytes = vec![];
        reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"abc123");
        let paths = requests.await.unwrap();
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.ends_with("operations/stat"))
                .count(),
            3
        );
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.ends_with("operations/getfile"))
                .count(),
            1
        );
    }

    fn response(status: u16, range: &str) -> reqwest::Response {
        http::Response::builder()
            .status(status)
            .header("Content-Range", range)
            .body(Vec::<u8>::new())
            .unwrap()
            .into()
    }
    #[test]
    fn validates_upstream_range_before_forwarding_bytes() {
        let range = Some((100, Some(199)));
        assert!(matches_file_range(
            &response(206, "bytes 100-199/1000"),
            range
        ));
        assert!(!matches_file_range(
            &response(200, "bytes 100-199/1000"),
            range
        ));
        assert!(!matches_file_range(
            &response(206, "bytes 0-99/1000"),
            range
        ));
        assert!(!matches_file_range(
            &response(206, "bytes 100-200/1000"),
            range
        ));
        assert!(!matches_file_range(&response(206, "bytes 100-/*"), range));
        assert!(!matches_file_range(
            &response(206, "bytes 100-90/1000"),
            range
        ));
        assert!(matches_file_range(&response(200, ""), None));
        assert!(!matches_file_range(&response(404, ""), None));
        assert!(!matches_file_range(
            &response(206, "bytes 100-150/1000"),
            range
        ));
        assert!(!matches_file_range(
            &response(206, "bytes 100-199/199"),
            range
        ));
        assert!(!matches_file_range(
            &response(206, "bytes 100-199/invalid"),
            range
        ));
        assert!(matches_file_range(
            &response(206, "bytes 100-150/151"),
            range
        ));
    }
}
