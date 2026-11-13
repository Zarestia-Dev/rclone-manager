//! File operation handlers (streaming, etc.)

use axum::{
    body::Body,
    extract::{Query, State},
    http::{
        HeaderMap, Method, StatusCode,
        header::{
            self, ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
        },
    },
    response::{IntoResponse, Response},
};

use serde::Deserialize;
use tokio_util::io::ReaderStream;

use super::common::{classify_failure, reject_parent_components};
use crate::utils::io::file_stream::{AssetSource, open_asset};
use crate::utils::io::http_helpers::{
    content_disposition, ensure_remote_colon, normalize_asset_path, resolve_byte_range,
};
use crate::utils::types::state::RcloneState;
use crate::web::state::{AppError, WebServerState};

#[derive(Deserialize)]
pub struct StreamRemoteFileQuery {
    remote: String,
    path: String,
    download: Option<bool>,
}

pub async fn stream_remote_file_handler(
    State(state): State<WebServerState>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<StreamRemoteFileQuery>,
) -> Result<Response, AppError> {
    reject_parent_components(&query.path)?;

    // Query extraction has already decoded percent escapes exactly once.
    let remote = ensure_remote_colon(&query.remote);
    let transport = state.app_handle.state::<RcloneState>().transport.clone();
    let source = open_asset(transport, &remote, &query.path)
        .await
        .map_err(classify_failure)?;

    let filename = query.path.split('/').next_back().unwrap_or("file");
    respond(
        source,
        &method,
        &headers,
        filename,
        &query.path,
        query.download.unwrap_or(false),
    )
    .await
}

#[derive(Deserialize)]
pub struct StreamFileQuery {
    path: String,
    download: Option<bool>,
}

pub async fn stream_file_handler(
    State(state): State<WebServerState>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<StreamFileQuery>,
) -> Result<Response, AppError> {
    let path = normalize_asset_path(query.path);
    reject_parent_components(&path)?;

    let transport = state.app_handle.state::<RcloneState>().transport.clone();
    let source = open_asset(transport, "", &path)
        .await
        .map_err(classify_failure)?;

    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    respond(
        source,
        &method,
        &headers,
        filename,
        &path,
        query.download.unwrap_or(false),
    )
    .await
}

/// Types a browser executes or renders with scripting when opened directly.
fn is_active_content(mime: &str) -> bool {
    matches!(
        mime,
        "text/html" | "application/xhtml+xml" | "image/svg+xml" | "text/xml" | "application/xml"
    )
}

/// Answers a GET/HEAD for `source`, honouring a single `Range` header.
async fn respond(
    source: AssetSource,
    method: &Method,
    headers: &HeaderMap,
    filename: &str,
    mime_path: &str,
    download: bool,
) -> Result<Response, AppError> {
    let total = source.total();
    let range_header = (method == Method::GET)
        .then(|| headers.get(header::RANGE).and_then(|v| v.to_str().ok()))
        .flatten();
    let range = match resolve_byte_range(range_header, total) {
        Ok(range) => range,
        Err(_) => {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(CONTENT_RANGE, format!("bytes */{total}"))],
            )
                .into_response());
        }
    };
    let (start, length) = range.map_or((0, total), |(start, end)| (start, end - start + 1));
    let reader = source
        .into_reader(start, length)
        .await
        .map_err(AppError::internal)?;
    let mime = mime_guess::from_path(mime_path)
        .first_or_octet_stream()
        .to_string();
    // The API shares the application's origin: script in a shared HTML or SVG
    // file must not run with the user's session when opened directly.
    let sandbox = is_active_content(&mime).then_some([(CONTENT_SECURITY_POLICY, "sandbox")]);
    Ok((
        if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        [
            (CONTENT_TYPE, mime),
            (CONTENT_LENGTH, length.to_string()),
            (CONTENT_DISPOSITION, content_disposition(download, filename)),
        ],
        [
            (CACHE_CONTROL, "no-store"),
            (ACCEPT_RANGES, "bytes"),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        sandbox,
        range.map(|(start, end)| [(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))]),
        Body::from_stream(ReaderStream::new(reader)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        use std::sync::Arc;
        let app = rclone_manager_core::context::AppHandle::default();
        app.manage(RcloneState::new(
            Default::default(),
            Arc::new(MediaTransport),
        ));
        let mut state = WebServerState::new(
            app,
            Arc::new(crate::services::bridge::EventBridge::new(8, None)),
            Some("unused".into()),
            false,
        );
        state.sessions = Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::from([
            (
                "media-session".into(),
                std::time::Instant::now() + std::time::Duration::from_secs(60),
            ),
        ])));
        crate::web::routes::build_api_router(state)
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
    #[test]
    fn only_scriptable_types_are_sandboxed() {
        for mime in [
            "text/html",
            "image/svg+xml",
            "application/xhtml+xml",
            "text/xml",
        ] {
            assert!(is_active_content(mime), "{mime}");
        }
        for mime in ["application/pdf", "audio/mpeg", "image/png", "text/plain"] {
            assert!(!is_active_content(mime), "{mime}");
        }
    }

    #[tokio::test]
    async fn streamed_files_cannot_be_sniffed_and_active_content_is_sandboxed() {
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        for (name, sandboxed) in [
            ("page.html", true),
            ("vector.svg", true),
            ("song.mp3", false),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, b"<script>alert(1)</script>").unwrap();
            let response = media_router()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(format!(
                            "/stream?path={}",
                            percent_encoding::utf8_percent_encode(
                                path.to_str().unwrap(),
                                percent_encoding::NON_ALPHANUMERIC
                            )
                        ))
                        .header("Cookie", "session=media-session")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "{name}");
            assert_eq!(response.headers()[X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert_eq!(
                response
                    .headers()
                    .get(CONTENT_SECURITY_POLICY)
                    .map(|value| value.to_str().unwrap()),
                sandboxed.then_some("sandbox"),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn parent_components_are_forbidden_not_bad_requests() {
        use tower::ServiceExt;
        let response = media_router()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/stream?path=%2Ftmp%2F..%2Fetc%2Fpasswd")
                    .header("Cookie", "session=media-session")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
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
