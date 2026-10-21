//! File operation handlers (streaming, etc.)

use std::io::SeekFrom;
use std::path::PathBuf;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::IntoResponse,
};

use serde::Deserialize;
use tokio::fs::File;
use tokio::io::AsyncSeekExt;
use tokio_util::io::ReaderStream;

use crate::utils::io::file_stream::{
    file_metadata, file_reader, local_file_reader, pin_file_transport,
};
use crate::utils::io::http_helpers::{
    classify_error_status, content_disposition, has_parent_path_component, normalize_asset_path,
    resolve_byte_range,
};
use crate::utils::types::state::RcloneState;
use crate::web::state::{AppError, WebServerState};

#[derive(Deserialize)]
pub struct StreamRemoteFileQuery {
    pub remote: String,
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_remote_file_handler(
    State(state): State<WebServerState>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<StreamRemoteFileQuery>,
) -> Result<impl IntoResponse, AppError> {
    if has_parent_path_component(&query.path) {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Path traversal denied"
        )));
    }

    // Query extraction has already decoded percent escapes exactly once.
    let remote = if query.remote.ends_with(':') {
        query.remote.clone()
    } else {
        format!("{}:", query.remote)
    };
    let transport = state.app_handle.state::<RcloneState>().transport.clone();
    let transport = pin_file_transport(transport).await.map_err(stream_error)?;
    let version = file_metadata(transport.as_ref(), &remote, &query.path)
        .await
        .map_err(stream_error)?;
    let total = version.size;
    let range = match resolve_byte_range(
        (method == Method::GET)
            .then(|| headers.get(header::RANGE).and_then(|v| v.to_str().ok()))
            .flatten(),
        total,
    ) {
        Ok(range) => range,
        Err(_) => return unsatisfiable_response(total),
    };
    let (start, length) = range.map_or((0, total), |(start, end)| (start, end - start + 1));
    let reader = file_reader(
        transport,
        remote,
        query.path.clone(),
        start,
        length,
        Some(version),
    );
    let byte_range = range.map(|(start, end)| (start, Some(end)));

    let filename = query.path.split('/').next_back().unwrap_or("file");
    let mime_type = mime_guess::from_path(&query.path)
        .first_or_octet_stream()
        .to_string();

    let body = axum::body::Body::from_stream(ReaderStream::new(reader));
    build_stream_response(
        body,
        filename,
        &mime_type,
        query.download.unwrap_or(false),
        byte_range,
        Some(total),
    )
}

#[derive(Deserialize)]
pub struct StreamFileQuery {
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_file_handler(
    State(state): State<WebServerState>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<StreamFileQuery>,
) -> Result<impl IntoResponse, AppError> {
    let path_str = normalize_asset_path(query.path);

    if has_parent_path_component(&path_str) {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Path traversal denied"
        )));
    }

    let path = PathBuf::from(&path_str);

    let range_header = (method == Method::GET)
        .then(|| headers.get(header::RANGE).and_then(|v| v.to_str().ok()))
        .flatten();

    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let mime_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();

    // Try standard local file opening first
    if let Ok(metadata) = tokio::fs::metadata(&path).await
        && !metadata.is_file()
    {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Only regular files can be streamed"
        )));
    }
    let file_result = File::open(&path).await;

    match file_result {
        Ok(mut file) => {
            let metadata = file.metadata().await.map_err(anyhow::Error::msg)?;
            if !metadata.is_file() {
                return Err(AppError::BadRequest(anyhow::anyhow!(
                    "Only regular files can be streamed"
                )));
            }
            let total_len = metadata.len();

            let byte_range = match resolve_byte_range(range_header, total_len) {
                Ok(range) => range.map(|(start, end)| (start, Some(end))),
                Err(_) => return unsatisfiable_response(total_len),
            };
            if let Some((start, end_opt)) = byte_range {
                file.seek(SeekFrom::Start(start))
                    .await
                    .map_err(anyhow::Error::msg)?;

                let count = match end_opt {
                    Some(end) if end >= start && end < total_len => end - start + 1,
                    _ => total_len - start,
                };

                let body = axum::body::Body::from_stream(ReaderStream::new(local_file_reader(
                    file, metadata, count,
                )));
                build_stream_response(
                    body,
                    &filename,
                    &mime_type,
                    query.download.unwrap_or(false),
                    Some((start, end_opt)),
                    Some(total_len),
                )
            } else {
                let body = axum::body::Body::from_stream(ReaderStream::new(local_file_reader(
                    file, metadata, total_len,
                )));
                build_stream_response(
                    body,
                    &filename,
                    &mime_type,
                    query.download.unwrap_or(false),
                    None,
                    Some(total_len),
                )
            }
        }
        Err(e) => {
            // Fallback to rclone cat
            log::debug!(
                "⚠️ Standard stream failed for {}, attempting cat fallback: {}",
                path_str,
                e
            );
            let rclone_state = state.app_handle.state::<RcloneState>();
            let transport = rclone_state.transport.clone();

            let transport = pin_file_transport(transport).await.map_err(stream_error)?;
            let version = file_metadata(transport.as_ref(), "", &path_str)
                .await
                .map_err(stream_error)?;
            let total = version.size;
            let range = match resolve_byte_range(range_header, total) {
                Ok(range) => range,
                Err(_) => return unsatisfiable_response(total),
            };
            let (start, length) = range.map_or((0, total), |(start, end)| (start, end - start + 1));
            let reader = file_reader(
                transport,
                String::new(),
                path_str,
                start,
                length,
                Some(version),
            );
            build_stream_response(
                axum::body::Body::from_stream(ReaderStream::new(reader)),
                &filename,
                &mime_type,
                query.download.unwrap_or(false),
                range.map(|(start, end)| (start, Some(end))),
                Some(total),
            )
        }
    }
}

fn stream_error(error: crate::rclone::backend::transport::BackendError) -> AppError {
    let message = error.to_string();
    match classify_error_status(&message) {
        StatusCode::NOT_FOUND => AppError::NotFound(message),
        StatusCode::FORBIDDEN | StatusCode::LOCKED => {
            AppError::BadRequest(anyhow::anyhow!(message))
        }
        _ => AppError::InternalServerError(anyhow::anyhow!(message)),
    }
}

fn unsatisfiable_response(total: u64) -> Result<axum::response::Response, AppError> {
    axum::response::Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
        .body(axum::body::Body::empty())
        .map_err(|e| AppError::InternalServerError(e.into()))
}

fn build_stream_response(
    body: axum::body::Body,
    filename: &str,
    mime_type: &str,
    download: bool,
    byte_range: Option<(u64, Option<u64>)>,
    total_len: Option<u64>,
) -> Result<axum::response::Response, AppError> {
    let mut builder = axum::response::Response::builder()
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CONTENT_DISPOSITION,
            content_disposition(download, filename),
        );

    if let Some((start, end_opt)) = byte_range {
        builder = builder.status(StatusCode::PARTIAL_CONTENT);
        if let Some(total) = total_len {
            let end = match end_opt {
                Some(e) if e >= start && e < total => e,
                _ => total.saturating_sub(1),
            };
            let length = end.saturating_sub(start) + 1;
            builder = builder
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}"),
                )
                .header(header::CONTENT_LENGTH, length.to_string());
        } else {
            return Err(AppError::InternalServerError(anyhow::anyhow!(
                "Partial response requires file length"
            )));
        }
    } else {
        builder = builder.status(StatusCode::OK);
        if let Some(total) = total_len {
            builder = builder.header(header::CONTENT_LENGTH, total.to_string());
        }
    }

    builder
        .body(body)
        .map_err(|e| AppError::InternalServerError(anyhow::anyhow!(e.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_stream_response_headers() {
        let body = axum::body::Body::empty();
        let resp =
            build_stream_response(body, "test.txt", "text/plain", false, None, Some(100)).unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert_eq!(resp.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(resp.headers().get(header::CONTENT_LENGTH).unwrap(), "100");
    }

    #[test]
    fn test_build_stream_response_partial_content() {
        let body = axum::body::Body::empty();
        let resp = build_stream_response(
            body,
            "video.mp4",
            "video/mp4",
            false,
            Some((0, Some(499))),
            Some(1000),
        )
        .unwrap();

        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 0-499/1000"
        );
        assert_eq!(resp.headers().get(header::CONTENT_LENGTH).unwrap(), "500");
    }
    struct MediaTransport;
    #[async_trait::async_trait]
    impl crate::rclone::backend::RcloneTransport for MediaTransport {
        async fn kind(&self) -> crate::rclone::backend::transport::TransportKind {
            crate::rclone::backend::transport::TransportKind::HttpDaemon
        }
        async fn rpc(
            &self,
            endpoint: &str,
            payload: Option<&serde_json::Value>,
        ) -> Result<serde_json::Value, crate::rclone::backend::transport::BackendError> {
            assert_eq!(endpoint, "operations/stat");
            let payload = payload.unwrap();
            assert_eq!(payload["fs"], "drive%20:");
            assert_eq!(payload["remote"], "music/şarkı #+%.mp3");
            Ok(serde_json::json!({"item": {"Size": 1000, "IsDir": false}}))
        }
        async fn read_file(
            &self,
            _: &str,
            _: &str,
            range: Option<(u64, Option<u64>)>,
        ) -> Result<
            Box<dyn tokio::io::AsyncRead + Unpin + Send>,
            crate::rclone::backend::transport::BackendError,
        > {
            let (start, end) = range.unwrap();
            Ok(Box::new(std::io::Cursor::new(
                (start..=end.unwrap())
                    .map(|n| (n % 251) as u8)
                    .collect::<Vec<_>>(),
            )))
        }
    }
    fn media_router() -> axum::Router {
        use std::sync::{Arc, atomic::AtomicBool};
        let app = rclone_manager_core::context::AppHandle::default();
        app.manage(RcloneState {
            client: Default::default(),
            transport: Arc::new(MediaTransport),
            is_shutting_down: AtomicBool::new(false),
            poller_running: AtomicBool::new(false),
            poller_visible: AtomicBool::new(false),
            initial_startup: AtomicBool::new(false),
            initialization_lock: tokio::sync::Mutex::new(()),
            vault_operation_lock: tokio::sync::Mutex::new(()),
            updater_running: AtomicBool::new(false),
        });
        crate::web::routes::build_api_router(WebServerState {
            app_handle: app,
            event_bridge: Arc::new(crate::services::bridge::EventBridge::new(8, None)),
            auth_credentials: Some(("user".into(), "unused".into())),
            sessions: Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::from([
                (
                    "media-session".into(),
                    std::time::Instant::now() + std::time::Duration::from_secs(60),
                ),
            ]))),
        })
    }
    #[tokio::test]
    async fn authenticated_media_routes_return_matching_headers_and_bytes() {
        use tower::ServiceExt;
        let router = media_router();
        let uri =
            "/stream/remote?remote=drive%2520%3A&path=music%2F%C5%9Fark%C4%B1%20%23%2B%25.mp3";
        for (range, status, start, end) in [
            (None, 200, 0, 999),
            (Some("bytes=0-"), 206, 0, 999),
            (Some("bytes=500-"), 206, 500, 999),
            (Some("bytes=0-1"), 206, 0, 1),
            (Some("bytes=-128"), 206, 872, 999),
            (Some("bytes=990-99999"), 206, 990, 999),
            (Some("bytes=0-1,4-5"), 200, 0, 999),
        ] {
            let mut req = axum::http::Request::builder()
                .uri(uri)
                .header("Cookie", "session=media-session");
            if let Some(range) = range {
                req = req.header(header::RANGE, range);
            }
            let response = router
                .clone()
                .oneshot(req.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                (end - start + 1).to_string()
            );
            if status == 206 {
                assert_eq!(
                    response.headers()[header::CONTENT_RANGE],
                    format!("bytes {start}-{end}/1000")
                );
            }
            let bytes = axum::body::to_bytes(response.into_body(), 2000)
                .await
                .unwrap();
            assert_eq!(
                bytes.as_ref(),
                (start..=end).map(|n| (n % 251) as u8).collect::<Vec<_>>()
            );
        }
        for (method, cookie, range, status) in [
            ("HEAD", true, "bytes=0-", 200),
            ("GET", true, "bytes=1000-", 416),
            ("GET", false, "bytes=0-", 401),
        ] {
            let mut req = axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .header(header::RANGE, range);
            if cookie {
                req = req.header("Cookie", "session=media-session");
            }
            let response = router
                .clone()
                .oneshot(req.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            // Axum executes the GET handler for HEAD and discards its body.
            assert_eq!(response.status(), status);
            if status == 416 {
                assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */1000");
            }
            if method == "HEAD" {
                assert_eq!(response.headers()[header::CONTENT_LENGTH], "1000");
                assert!(!response.headers().contains_key(header::CONTENT_RANGE));
                assert!(
                    axum::body::to_bytes(response.into_body(), 2000)
                        .await
                        .unwrap()
                        .is_empty()
                );
            }
        }
    }
    #[tokio::test]
    async fn local_media_route_supports_suffix_ranges_and_empty_files() {
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("şarkı #+.mp3");
        std::fs::write(&path, b"0123456789").unwrap();
        let uri = format!(
            "/stream?path={}",
            percent_encoding::utf8_percent_encode(
                path.to_str().unwrap(),
                percent_encoding::NON_ALPHANUMERIC
            )
        );
        let request = || {
            axum::http::Request::builder()
                .uri(&uri)
                .header("Cookie", "session=media-session")
                .header(header::RANGE, "bytes=-3")
                .body(axum::body::Body::empty())
                .unwrap()
        };
        let response = media_router().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 7-9/10");
        assert_eq!(
            &axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()[..],
            b"789"
        );
        std::fs::write(&path, b"").unwrap();
        let response = media_router().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), 416);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */0");
    }
}
