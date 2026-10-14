use crate::context::AppHandle;
use crate::utils::io::file_stream::{FILE_CHUNK_SIZE, file_metadata, file_reader};
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncReadExt;

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
                // Fall back to rclone cat via core/command (e.g. for reading local paths on remote daemon hosts)
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
                let backend_manager = self.app.try_state::<BackendManager>().ok_or_else(|| {
                    BackendError::NotConnected("BackendManager not in state".into())
                })?;
                let os = backend_manager.get_runtime_os(&backend.name).await;

                let payload = cat_stream_payload(&backend, remote, path, range, os)?;
                let response = backend
                    .make_request(
                        &client,
                        reqwest::Method::POST,
                        crate::rclone::endpoints::core::COMMAND,
                        Some(&payload),
                        None,
                    )
                    .await?;
                // Do not trust a daemon to honour --count: bound the fallback
                // body too, including rcserver's three-byte JSON trailer.
                let limit = count
                    .ok_or_else(|| BackendError::Stream("Missing bounded file range".into()))?
                    + 3;
                let stream = response
                    .bytes_stream()
                    .map(|result| result.map_err(std::io::Error::other));
                let bytes =
                    read_cat_stream(tokio_util::io::StreamReader::new(stream), limit).await?;

                Ok(Box::new(std::io::Cursor::new(bytes)))
            }
        }
    }
}

fn cat_stream_payload(
    backend: &Backend,
    remote: &str,
    path: &str,
    range: Option<(u64, Option<u64>)>,
    os: Option<String>,
) -> Result<Value, BackendError> {
    let full_path = if remote.is_empty() || remote == ":" {
        path.to_string()
    } else {
        let remote = if remote.ends_with(':') || remote.contains('/') || remote.contains('\\') {
            remote.to_string()
        } else {
            format!("{remote}:")
        };
        crate::utils::json_helpers::build_full_path(&remote, path)
    };
    let mut args = vec![full_path];
    if let Some((start, end)) = range {
        let offset = i64::try_from(start).map_err(|e| BackendError::Other(e.to_string()))?;
        args.push(format!("--offset={offset}"));
        if let Some(end) = end {
            let count = end
                .checked_sub(start)
                .and_then(|n| n.checked_add(1))
                .and_then(|n| i64::try_from(n).ok())
                .ok_or_else(|| BackendError::Other("Invalid file range".into()))?;
            args.push(format!("--count={count}"));
        }
    }
    let mut payload = backend.build_core_command_payload("cat", args, false, os);
    // COMBINED_OUTPUT converts arbitrary bytes to a JSON string, irreversibly
    // replacing invalid UTF-8. Keep stdout binary and stderr out of the file.
    payload["returnType"] = serde_json::json!("STREAM_ONLY_STDOUT");
    Ok(payload)
}

async fn read_cat_stream(
    reader: impl tokio::io::AsyncRead + Unpin,
    limit: u64,
) -> Result<Vec<u8>, BackendError> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| BackendError::Stream(e.to_string()))?;
    if bytes.len() as u64 > limit {
        return Err(BackendError::Stream(
            "rclone cat exceeded the requested byte count".into(),
        ));
    }
    let length = decode_cat_stream(&bytes)?.len();
    bytes.truncate(length);
    Ok(bytes)
}

fn decode_cat_stream(bytes: &[u8]) -> Result<&[u8], BackendError> {
    // rcserver appends the empty JSON result after streamed stdout. Remove only
    // that exact trailer; command failures append an error object instead.
    bytes.strip_suffix(b"{}\n").ok_or_else(|| {
        BackendError::Stream("rclone cat stream did not complete successfully".into())
    })
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
    fn test_transport(port: u16) -> RcHttpBackend {
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        let flag = || AtomicBool::new(false);
        app.manage(RcloneState {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap(),
            transport: std::sync::Arc::new(RcHttpBackend::new(app.clone())),
            is_shutting_down: flag(),
            poller_running: flag(),
            poller_visible: flag(),
            initial_startup: flag(),
            updater_running: flag(),
            initialization_lock: tokio::sync::Mutex::new(()),
            vault_operation_lock: tokio::sync::Mutex::new(()),
        });
        let backend = Backend::new_remote("test", "127.0.0.1", port);
        let dynamic = RcHttpBackend::new(app);
        dynamic.for_backend(backend)
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
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc{}\n"
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
    async fn unbounded_cat_fallback_returns_a_lazy_chunked_reader() {
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
                    ("200 OK", "abc123{}\n")
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
                .filter(|path| path.ends_with("core/command"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn cat_fallback_bounds_bytes_and_requires_a_complete_trailer() {
        assert_eq!(read_cat_stream(&b"abc{}\n"[..], 6).await.unwrap(), b"abc");
        assert!(read_cat_stream(&b"abcd{}\n"[..], 6).await.is_err());
        assert!(read_cat_stream(&b"abc{"[..], 6).await.is_err());
        assert!(
            read_cat_stream(&b"abc{\"error\":\"failed\"}\n"[..], 100)
                .await
                .is_err()
        );
        assert!(read_cat_stream(&b"{}\n"[..], 3).await.unwrap().is_empty());
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
    fn binary_cat_fallback_preserves_non_utf8_and_removes_only_rc_trailer() {
        let binary: Vec<u8> = (0..=255).chain(b"{}\n".iter().copied()).collect();
        let mut response = binary.clone();
        response.extend_from_slice(b"{}\n");
        assert_eq!(decode_cat_stream(&response).unwrap(), binary);
        assert!(decode_cat_stream(b"partial{\"error\":\"failed\"}\n").is_err());
        assert!(decode_cat_stream(b"").is_err());
        assert_eq!(decode_cat_stream(b"{}\n").unwrap(), Vec::<u8>::new());
        let backend = Backend::new_remote("test", "localhost", 1234);
        let payload =
            cat_stream_payload(&backend, "drive:", "a #+.mp3", Some((100, Some(199))), None)
                .unwrap();
        assert_eq!(payload["returnType"], "STREAM_ONLY_STDOUT");
        assert_eq!(payload["arg"][0], "drive:a #+.mp3");
        assert_eq!(payload["arg"][1], "--offset=100");
        assert_eq!(payload["arg"][2], "--count=100");
        assert!(cat_stream_payload(&backend, "", "file", Some((10, Some(9))), None).is_err());
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
