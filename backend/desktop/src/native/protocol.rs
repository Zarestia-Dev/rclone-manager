//! Custom URI scheme protocol handlers for Tauri (`rclone://`, `local-asset://`, `audio-cover://`).
//!
//! ### Known Platform Limitations:
//! - **Linux Desktop (WebKitGTK + GStreamer)**:
//!   WebKitGTK delegates HTML5 `<audio>` and `<video>` playback directly to GStreamer.
//!   Because GStreamer operates out-of-process and lacks a URI handler plugin for custom
//!   application schemes (`rclone://` and `local-asset://`), media playback of audio and video files
//!   fails with `MediaError { code: 4 }` (`MEDIA_ERR_SRC_NOT_SUPPORTED`).
//!   Static assets, text, and images (such as `audio-cover://`) load normally through WebKit's network stack (`libsoup`).
//!   On mobile (Android Chromium) and headless web-server modes, media playback functions properly.
//!   See tracking issue: <https://github.com/tauri-apps/tauri/issues/3725>.

use crate::context::BackendContext;
use rclone_manager_core::context::AppHandle as CoreHandle;
use std::path::Path;

use http::{Method, Request, Response, StatusCode, header};
use log::{debug, error, warn};
use tauri::{Builder, Runtime};
use tokio::io::AsyncReadExt;

use crate::utils::app::audio;
use crate::utils::io::file_stream::{FILE_CHUNK_SIZE, open_asset, pin_file_transport};
use crate::utils::io::http_helpers::{
    MAX_AUDIO_COVER_PROBE_BYTES, classify_error_status, decode_remote_name,
    has_parent_path_component, normalize_asset_path, resolve_byte_range, strip_protocol_prefix,
    strip_protocol_prefix_trimmed, url_decode,
};
use crate::utils::types::state::RcloneState;

// Wry's native protocol response owns its full body. Range requests remain
// bounded separately; large full downloads use the disk-streaming command.
const MAX_BUFFERED_ASSET_BYTES: u64 = 64 * 1024 * 1024;

// A shared budget bounds simultaneous Rust-side response buffers as well as
// each individual response. Hold the permit through responder.respond().
static NATIVE_BODY_BUDGET: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_BUFFERED_ASSET_BYTES as usize);
type AssetResponse = (
    Response<Vec<u8>>,
    Option<tokio::sync::SemaphorePermit<'static>>,
);

async fn body_permit(length: u64) -> Result<Option<tokio::sync::SemaphorePermit<'static>>, String> {
    if length == 0 {
        return Ok(None);
    }
    let count = u32::try_from(length).map_err(|e| e.to_string())?;
    NATIVE_BODY_BUDGET
        .acquire_many(count)
        .await
        .map(Some)
        .map_err(|e| e.to_string())
}

pub fn register_protocols<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    let builder = register_guarded(builder, "rclone", handle_rclone);
    let builder = register_guarded(builder, "local-asset", handle_local_asset);
    register_guarded(builder, "audio-cover", handle_audio_cover)
}

/// What every scheme needs before its own handler runs: a locked vault answers 423,
/// `OPTIONS` answers the CORS preflight, and the finished response is withheld if the
/// vault session ended while it was being produced.
fn register_guarded<R: Runtime>(
    builder: Builder<R>,
    scheme: &'static str,
    handler: fn(CoreHandle, Request<Vec<u8>>, VaultResponder),
) -> Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(scheme, move |context, request, responder| {
        let core = context.app_handle().backend();
        if crate::services::settings::access::is_locked(core) {
            responder.respond(error_response(
                423,
                crate::services::settings::access::locked_error(),
            ));
            return;
        }
        let label = format!(
            "{scheme} {} {} range={}",
            request.method(),
            request.uri().path(),
            range_header(&request).as_deref().unwrap_or("-")
        );
        let responder = VaultResponder::new(core, responder, label.clone());
        if request.method() == Method::OPTIONS {
            responder.respond(cors_preflight_response());
            return;
        }
        debug!("{label} requested");
        handler(core.clone(), request, responder);
    })
}

fn cors_preflight_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(204)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "*")
        .body(vec![])
        .unwrap()
}

/// Helper to construct a standard CORS-enabled error/status HTTP response.
pub fn error_response(
    status: impl TryInto<StatusCode>,
    body: impl Into<Vec<u8>>,
) -> Response<Vec<u8>> {
    let status_code = status
        .try_into()
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    Response::builder()
        .status(status_code)
        .header("Access-Control-Allow-Origin", "*")
        .body(body.into())
        .unwrap()
}

// Keep buffered responses from escaping after the session that requested them ends.
struct VaultResponder {
    responder: tauri::UriSchemeResponder,
    app: CoreHandle,
    revision: u64,
    /// What was asked for, for the completion line in the log.
    label: String,
    started: std::time::Instant,
}

impl VaultResponder {
    fn new(app: &CoreHandle, responder: tauri::UriSchemeResponder, label: String) -> Self {
        let access = app
            .try_state::<std::sync::Arc<crate::services::settings::access::VaultAccess>>()
            .map(|s| s.inner().clone());
        let revision = access.as_ref().map_or(0, |a| a.revision());
        Self {
            responder,
            app: app.clone(),
            revision,
            label,
            started: std::time::Instant::now(),
        }
    }

    fn respond(self, response: Response<Vec<u8>>) {
        let response = if crate::services::settings::access::is_locked(&self.app)
            || self
                .app
                .try_state::<std::sync::Arc<crate::services::settings::access::VaultAccess>>()
                .is_some_and(|access| !access.permits(self.revision))
        {
            error_response(423, crate::services::settings::access::locked_error())
        } else {
            response
        };
        // A request that never reaches this line is one the backend never answered.
        let (status, bytes, elapsed) = (
            response.status(),
            response.body().len(),
            self.started.elapsed(),
        );
        if status.is_client_error() || status.is_server_error() {
            warn!("{} -> {status} in {elapsed:.1?}", self.label);
        } else {
            debug!("{} -> {status}, {bytes} B in {elapsed:.1?}", self.label);
        }
        self.responder.respond(response);
    }

    /// Answers with an asset (or the error it failed with), then releases its buffer budget.
    fn respond_asset(self, result: Result<AssetResponse, String>) {
        let (response, _permit) =
            result.unwrap_or_else(|e| (error_response(classify_error_status(&e), e), None));
        self.respond(response);
    }
}

fn range_header(request: &Request<Vec<u8>>) -> Option<String> {
    request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// `rclone://<remote>/<path>`: a file on a configured remote.
fn handle_rclone(core: CoreHandle, request: Request<Vec<u8>>, responder: VaultResponder) {
    let uri = request.uri().to_string();
    let rest = strip_protocol_prefix_trimmed(&uri, "rclone");
    let (remote_part, path_part) = rest.split_once('/').unwrap_or((rest, ""));
    let remote = decode_remote_name(remote_part);
    let path = url_decode(path_part);
    debug!("🔍 Parsed remote: '{remote}', path: '{path}'");

    let range = range_header(&request);
    let head = request.method() == Method::HEAD;
    crate::utils::spawn(async move {
        let transport = core.state::<RcloneState>().transport.clone();
        let result = asset_response(transport, &remote, &path, range.as_deref(), head).await;
        responder.respond_asset(result);
    });
}

/// `local-asset://<absolute path>`: a file on this machine.
fn handle_local_asset(core: CoreHandle, request: Request<Vec<u8>>, responder: VaultResponder) {
    let uri = request.uri().to_string();
    let path = normalize_asset_path(url_decode(strip_protocol_prefix(&uri, "local-asset")));
    debug!("🔍 Final decoded path: '{path}'");

    // SECURITY: refuse basic path traversal.
    if has_parent_path_component(&path) {
        error!("❌ Path traversal attempt blocked: '{path}'");
        responder.respond(error_response(403, "Path traversal denied"));
        return;
    }

    let range = range_header(&request);
    let head = request.method() == Method::HEAD;
    crate::utils::spawn(async move {
        #[cfg(target_os = "android")]
        let path = android_storage_alias(path).await;
        let transport = core.state::<RcloneState>().transport.clone();
        let result = asset_response(transport, "", &path, range.as_deref(), head).await;
        responder.respond_asset(result);
    });
}

/// Android exposes shared storage as `/sdcard`, an alias of `/storage/emulated/0`.
#[cfg(target_os = "android")]
async fn android_storage_alias(path: String) -> String {
    if path.starts_with("/sdcard/") {
        let alias = path.replacen("/sdcard/", "/storage/emulated/0/", 1);
        if tokio::fs::try_exists(&alias).await.unwrap_or(false) {
            return alias;
        }
    }
    path
}

/// Bound native response bodies before reading; HEAD reports metadata without a body.
fn asset_response_builder(
    mime: &str,
    range: Option<&str>,
    total: u64,
    head: bool,
) -> (http::response::Builder, u64, u64) {
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header(header::ACCEPT_RANGES, "bytes");
    match resolve_byte_range(if head { None } else { range }, total) {
        Err(_) => (
            builder
                .status(416)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .header(header::CONTENT_LENGTH, "0"),
            0,
            0,
        ),
        Ok(Some((start, end))) => {
            let end = end.min(start.saturating_add(FILE_CHUNK_SIZE - 1));
            let length = end - start + 1;
            (
                builder
                    .status(206)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{total}"),
                    )
                    .header(header::CONTENT_LENGTH, length),
                start,
                length,
            )
        }
        Ok(None) if !head && total > MAX_BUFFERED_ASSET_BYTES => (
            builder
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .header(header::CONTENT_LENGTH, 0),
            0,
            0,
        ),
        Ok(None) => (
            builder.status(200).header(header::CONTENT_LENGTH, total),
            0,
            total,
        ),
    }
}

/// Reads the requested part of a file into one response. An empty `remote` is a path on
/// this machine, opened directly when possible.
async fn asset_response(
    transport: std::sync::Arc<dyn crate::rclone::backend::RcloneTransport>,
    remote: &str,
    path: &str,
    range: Option<&str>,
    head: bool,
) -> Result<AssetResponse, String> {
    let source = open_asset(transport, remote, path).await?;
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    let (builder, start, length) = asset_response_builder(&mime, range, source.total(), head);
    if head || length == 0 {
        return Ok((builder.body(Vec::new()).map_err(|e| e.to_string())?, None));
    }
    let permit = body_permit(length).await?;
    let mut bytes = Vec::with_capacity(length as usize);
    source
        .into_reader(start, length)
        .await
        .map_err(|e| e.to_string())?
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok((builder.body(bytes).map_err(|e| e.to_string())?, permit))
}

/// `audio-cover://local/<path>` or `audio-cover://remote/<remote>/<path>`: embedded cover art.
fn handle_audio_cover(core: CoreHandle, request: Request<Vec<u8>>, responder: VaultResponder) {
    let uri = request.uri().to_string();
    let target = strip_protocol_prefix_trimmed(&uri, "audio-cover");

    if let Some(local_path) = target.strip_prefix("local/") {
        let path = normalize_asset_path(url_decode(local_path));
        if has_parent_path_component(&path) {
            responder.respond(error_response(403, "Path traversal denied"));
            return;
        }
        crate::utils::spawn(async move {
            let picture = audio::extract_picture_from_path(path).await;
            responder.respond(picture_response(picture));
        });
    } else if let Some(remote_target) = target.strip_prefix("remote/") {
        let (remote_part, path_part) = remote_target.split_once('/').unwrap_or((remote_target, ""));
        let (remote, path) = (decode_remote_name(remote_part), url_decode(path_part));
        crate::utils::spawn(async move {
            responder.respond(remote_cover_response(&core, &remote, &path).await);
        });
    } else {
        responder.respond(error_response(400, vec![]));
    }
}

fn picture_response(picture: Option<audio::PictureData>) -> Response<Vec<u8>> {
    match picture {
        Some(picture) => Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, picture.mime_type)
            .header("Access-Control-Allow-Origin", "*")
            .header(header::CACHE_CONTROL, "no-store")
            .body(picture.data)
            .unwrap(),
        None => error_response(404, vec![]),
    }
}

async fn remote_cover_response(core: &CoreHandle, remote: &str, path: &str) -> Response<Vec<u8>> {
    let transport = core.state::<RcloneState>().transport.clone();
    let transport = match pin_file_transport(transport).await {
        Ok(transport) => transport,
        Err(error) => return error_response(500, error.to_string()),
    };
    let Some(_input_permit) = audio::cover_input_permit().await else {
        return error_response(503, "Cover reader unavailable");
    };
    let range = Some((0, Some(MAX_AUDIO_COVER_PROBE_BYTES - 1)));
    let reader = match transport.read_file(remote, path, range).await {
        Ok(reader) => reader,
        Err(e) => {
            warn!("Failed to fetch remote cover for {remote}:{path}: {e}");
            return error_response(500, vec![]);
        }
    };
    let mut bytes = Vec::new();
    if reader
        .take(MAX_AUDIO_COVER_PROBE_BYTES)
        .read_to_end(&mut bytes)
        .await
        .is_err()
        || bytes.is_empty()
    {
        return error_response(404, vec![]);
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_owned);
    picture_response(audio::extract_picture_from_bytes(bytes, extension).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn simultaneous_native_responses_share_one_buffer_budget() {
        let permit = body_permit(MAX_BUFFERED_ASSET_BYTES).await.unwrap();
        assert!(NATIVE_BODY_BUDGET.try_acquire_many(1).is_err());
        drop(permit);
        assert!(
            NATIVE_BODY_BUDGET
                .try_acquire_many(MAX_BUFFERED_ASSET_BYTES as u32)
                .is_ok()
        );
        assert!(body_permit(0).await.unwrap().is_none());
    }

    #[test]
    fn large_full_native_responses_do_not_allocate_the_file() {
        let total = MAX_BUFFERED_ASSET_BYTES + 1;
        for range in [None, Some("garbage"), Some("bytes=0-1,4-5")] {
            let (builder, _, length) = asset_response_builder("video/mp4", range, total, false);
            assert_eq!(length, 0);
            let response = builder.body(()).unwrap();
            assert_eq!(response.status(), 413);
            assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
        }
        let (builder, _, length) =
            asset_response_builder("video/mp4", None, MAX_BUFFERED_ASSET_BYTES, false);
        assert_eq!(length, MAX_BUFFERED_ASSET_BYTES);
        assert_eq!(builder.body(()).unwrap().status(), 200);
        let (builder, _, length) =
            asset_response_builder("video/mp4", Some("bytes=0-"), total, false);
        assert_eq!(length, FILE_CHUNK_SIZE);
        assert_eq!(builder.body(()).unwrap().status(), 206);
        let (builder, _, _) = asset_response_builder("video/mp4", Some("bytes=0-"), total, true);
        let response = builder.body(()).unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            total.to_string()
        );
    }

    #[test]
    fn native_media_responses_have_complete_bounded_ranges() {
        let total = FILE_CHUNK_SIZE * 10;
        let (builder, start, length) =
            asset_response_builder("video/mp4", Some("bytes=0-"), total, false);
        let response = builder.body(Vec::<u8>::new()).unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!((start, length), (0, FILE_CHUNK_SIZE));
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 0-{}/{total}", FILE_CHUNK_SIZE - 1)
        );
        let (builder, start, length) =
            asset_response_builder("audio/mpeg", Some("bytes=-128"), total, false);
        assert_eq!((start, length), (total - 128, 128));
        assert_eq!(builder.body(()).unwrap().status(), 206);
        let (builder, _, length) = asset_response_builder("audio/mpeg", Some("bytes=0-"), 0, false);
        assert_eq!(length, 0);
        assert_eq!(builder.body(()).unwrap().status(), 416);
    }

    #[test]
    fn test_error_response() {
        let resp = error_response(StatusCode::NOT_FOUND, "not found text");
        assert_eq!(resp.status(), 404);
        assert_eq!(
            resp.headers().get("Access-Control-Allow-Origin").unwrap(),
            "*"
        );
        assert_eq!(resp.body(), b"not found text");

        let resp_u16 = error_response(403, "forbidden");
        assert_eq!(resp_u16.status(), 403);
    }

    /// A backend that has no files, so only direct local reads can succeed.
    struct NoRemoteFiles;
    #[async_trait::async_trait]
    impl crate::rclone::backend::RcloneTransport for NoRemoteFiles {
        async fn kind(&self) -> crate::rclone::backend::transport::TransportKind {
            crate::rclone::backend::transport::TransportKind::Librclone
        }
        async fn rpc(
            &self,
            _: &str,
            _: Option<&serde_json::Value>,
        ) -> Result<serde_json::Value, crate::rclone::backend::transport::BackendError> {
            Err(crate::rclone::backend::transport::BackendError::Other(
                "object not found".into(),
            ))
        }
        async fn read_file(
            &self,
            _: &str,
            _: &str,
            _: Option<(u64, Option<u64>)>,
        ) -> Result<
            Box<dyn tokio::io::AsyncRead + Unpin + Send>,
            crate::rclone::backend::transport::BackendError,
        > {
            unreachable!("local files are read directly")
        }
    }

    async fn local_asset(
        path: &Path,
        range: Option<&str>,
        head: bool,
    ) -> Result<AssetResponse, String> {
        asset_response(
            std::sync::Arc::new(NoRemoteFiles),
            "",
            path.to_str().unwrap(),
            range,
            head,
        )
        .await
    }

    #[tokio::test]
    async fn local_assets_are_served_whole_or_by_range() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.txt");
        tokio::fs::write(&path, b"0123456789").await.unwrap();

        let (response, _) = local_asset(&path, None, false).await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(response.body(), b"0123456789");

        let (response, _) = local_asset(&path, Some("bytes=2-4"), false).await.unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(response.body(), b"234");

        let (response, permit) = local_asset(&path, None, true).await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert!(response.body().is_empty() && permit.is_none());

        let (response, _) = local_asset(&path, Some("bytes=50-"), false).await.unwrap();
        assert_eq!(response.status(), 416);
    }

    #[tokio::test]
    async fn directories_and_missing_files_map_to_forbidden_and_not_found() {
        let directory = tempfile::tempdir().unwrap();
        let error = local_asset(directory.path(), None, false)
            .await
            .err()
            .unwrap();
        assert_eq!(classify_error_status(&error), StatusCode::FORBIDDEN);

        let error = local_asset(&directory.path().join("gone.txt"), None, false)
            .await
            .err()
            .unwrap();
        assert_eq!(classify_error_status(&error), StatusCode::NOT_FOUND);
    }
}
