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
use std::io::SeekFrom;
use std::path::Path;

use http::{Method, Response, StatusCode, header};
use log::{debug, error, warn};
use tauri::{Builder, Runtime};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::utils::app::audio;
use crate::utils::io::file_stream::{
    FILE_CHUNK_SIZE, file_metadata, file_reader, pin_file_transport,
};
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

pub fn register_protocols<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder = register_rclone_protocol(builder);
    builder = register_local_asset_protocol(builder);
    builder = register_audio_cover_protocol(builder);
    builder
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

fn register_rclone_protocol<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder =
        builder.register_asynchronous_uri_scheme_protocol("rclone", |app, request, responder| {
            if request.method() == Method::OPTIONS {
                responder.respond(cors_preflight_response());
                return;
            }

            // Capture an incoming Range header so we can forward it later
            let range_header = request
                .headers()
                .get("Range")
                .and_then(|v| v.to_str().ok())
                .map(std::string::ToString::to_string);

            let uri = request.uri().to_string();
            debug!("🔍 rclone protocol handler received URI: {uri}");
            let path_part = strip_protocol_prefix_trimmed(&uri, "rclone");

            // Find the first slash to separate remote from path
            let (remote_part, path_part) = match path_part.find('/') {
                Some(idx) => (&path_part[..idx], &path_part[idx + 1..]),
                None => (path_part, ""),
            };

            let remote = decode_remote_name(remote_part);
            let path = url_decode(path_part);

            debug!("🔍 Parsed remote: '{remote}', path: '{path}'");

            let app_handle = app.app_handle().clone();
            crate::utils::spawn(async move {
                let rclone_state =
                    app_handle.backend_state::<crate::utils::types::state::RcloneState>();
                let transport = rclone_state.transport.clone();

                let result = remote_asset_response(
                    transport,
                    &remote,
                    &path,
                    range_header.as_deref(),
                    request.method() == Method::HEAD,
                )
                .await;
                let (response, _permit) =
                    result.unwrap_or_else(|e| (error_response(classify_error_status(&e), e), None));
                responder.respond(response);
            });
        });
    builder
}

fn register_local_asset_protocol<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder =
        builder.register_asynchronous_uri_scheme_protocol("local-asset", |app, request, responder| {
            if request.method() == Method::OPTIONS {
                responder.respond(cors_preflight_response());
                return;
            }

            let uri = request.uri().to_string();
            debug!("🔍 local-asset protocol handler received URI: {uri}");

            let path_part = strip_protocol_prefix(&uri, "local-asset");
            let decoded_path = url_decode(path_part);
            let mut final_path = normalize_asset_path(decoded_path);

            debug!("🔍 Final decoded path: '{final_path}'");

            // SECURITY 1: Prevent basic path traversal attacks
            if has_parent_path_component(&final_path) {
                error!("❌ Path traversal attempt blocked: '{final_path}'");
                responder.respond(error_response(403, "Path traversal denied"));
                return;
            }

            // Determine mime type
            let mime_type = mime_guess::from_path(&final_path)
                .first_or_octet_stream()
                .to_string();

            let app_handle = app.app_handle().clone();

            // Use async runtime to support cat fallback
            crate::utils::spawn(async move {
                // Filesystem checks belong off the WebView callback thread.
                if final_path.starts_with("/sdcard/") {
                    let alias = final_path.replacen("/sdcard/", "/storage/emulated/0/", 1);
                    if tokio::fs::try_exists(&alias).await.unwrap_or(false) { final_path = alias; }
                }
                let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
                let head = request.method() == Method::HEAD;
                if let Ok(metadata) = tokio::fs::metadata(&final_path).await
                    && !metadata.is_file()
                {
                    responder.respond(error_response(403, "Only regular files can be streamed"));
                    return;
                }
                let result = match tokio::fs::File::open(&final_path).await {
                    Ok(mut file) => async {
                        let metadata = file.metadata().await.map_err(|e| e.to_string())?;
                        if !metadata.is_file() { return Err("Permission denied: only regular files can be streamed".into()); }
                        let total = metadata.len();
                        let (builder, start, length) = asset_response_builder(&mime_type, range, total, head);
                        if head || length == 0 { return Ok((builder.body(Vec::new()).unwrap(), None)); }
                        let permit = body_permit(length).await?;
                        file.seek(SeekFrom::Start(start)).await.map_err(|e| e.to_string())?;
                        let mut bytes = Vec::with_capacity(length as usize);
                        (&mut file).take(length).read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
                        if bytes.len() as u64 != length { return Err("File changed during streaming".into()); }
                        let after = file.metadata().await.map_err(|e| e.to_string())?;
                        if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() { return Err("File changed during streaming".into()); }
                        Ok((builder.body(bytes).unwrap(), permit))
                    }.await,
                    Err(e) => {
                        warn!("Standard open failed for {final_path}, attempting transport fallback: {e}");
                        let transport = app_handle.backend_state::<RcloneState>().transport.clone();
                        remote_asset_response(transport, "", &final_path, range, head).await
                    }
                };
                let (response, _permit) = result.unwrap_or_else(|e| (error_response(classify_error_status(&e), e), None));
                responder.respond(response);

            });
        });
    builder
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

async fn remote_asset_response(
    transport: std::sync::Arc<dyn crate::rclone::backend::RcloneTransport>,
    remote: &str,
    path: &str,
    range: Option<&str>,
    head: bool,
) -> Result<AssetResponse, String> {
    let transport = pin_file_transport(transport)
        .await
        .map_err(|e| e.to_string())?;
    let version = file_metadata(transport.as_ref(), remote, path)
        .await
        .map_err(|e| e.to_string())?;
    let total = version.size;
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    let (builder, start, length) = asset_response_builder(&mime, range, total, head);
    let permit = body_permit(if head { 0 } else { length }).await?;
    let mut bytes = Vec::with_capacity(if head { 0 } else { length as usize });
    if !head && length > 0 {
        file_reader(
            transport,
            remote.to_string(),
            path.to_string(),
            start,
            length,
            Some(version),
        )
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok((builder.body(bytes).map_err(|e| e.to_string())?, permit))
}

fn register_audio_cover_protocol<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder = builder.register_asynchronous_uri_scheme_protocol(
        "audio-cover",
        |app, request, responder| {
            if request.method() == Method::OPTIONS {
                responder.respond(cors_preflight_response());
                return;
            }

            let uri = request.uri().to_string();
            debug!("🔍 audio-cover protocol handler received URI: {uri}");
            let path_part = strip_protocol_prefix_trimmed(&uri, "audio-cover");

            if let Some(local_path) = path_part.strip_prefix("local/") {
                // Local file extraction
                let decoded_path = normalize_asset_path(url_decode(local_path));

                crate::utils::spawn(async move {
                    let picture = audio::extract_picture_from_path(decoded_path).await;
                    if let Some(pic) = picture {
                        responder.respond(
                            Response::builder()
                                .status(200)
                                .header(header::CONTENT_TYPE, pic.mime_type)
                                .header("Access-Control-Allow-Origin", "*")
                                .header("Cache-Control", "no-store")
                                .body(pic.data)
                                .unwrap(),
                        );
                    } else {
                        responder.respond(error_response(404, vec![]));
                    }
                });
            } else if let Some(remote_part) = path_part.strip_prefix("remote/") {
                // Remote file extraction
                let (remote_enc, path_enc) = match remote_part.find('/') {
                    Some(idx) => (&remote_part[..idx], &remote_part[idx + 1..]),
                    None => (remote_part, ""),
                };

                let remote = decode_remote_name(remote_enc);
                let path = url_decode(path_enc);

                let app_handle = app.app_handle().clone();
                crate::utils::spawn(async move {
                    let rclone_state =
                        app_handle.backend_state::<crate::utils::types::state::RcloneState>();
                    let transport = rclone_state.transport.clone();

                    let transport = match pin_file_transport(transport).await {
                        Ok(transport) => transport,
                        Err(error) => {
                            responder.respond(error_response(500, error.to_string()));
                            return;
                        }
                    };
                    let Some(_input_permit) = audio::cover_input_permit().await else {
                        responder.respond(error_response(503, "Cover reader unavailable"));
                        return;
                    };
                    match transport
                        .read_file(
                            &remote,
                            &path,
                            Some((0, Some(MAX_AUDIO_COVER_PROBE_BYTES - 1))),
                        )
                        .await
                    {
                        Ok(reader) => {
                            let mut bytes = Vec::new();
                            if reader
                                .take(MAX_AUDIO_COVER_PROBE_BYTES)
                                .read_to_end(&mut bytes)
                                .await
                                .is_ok()
                                && !bytes.is_empty()
                            {
                                let extension = Path::new(&path)
                                    .extension()
                                    .and_then(|ext| ext.to_str())
                                    .map(str::to_owned);
                                let picture =
                                    audio::extract_picture_from_bytes(bytes, extension).await;
                                if let Some(pic) = picture {
                                    responder.respond(
                                        Response::builder()
                                            .status(200)
                                            .header(header::CONTENT_TYPE, pic.mime_type)
                                            .header("Access-Control-Allow-Origin", "*")
                                            .header("Cache-Control", "no-store")
                                            .body(pic.data)
                                            .unwrap(),
                                    );
                                    return;
                                }
                            }
                            responder.respond(error_response(404, vec![]));
                        }
                        Err(e) => {
                            warn!("Failed to fetch remote cover for {remote}:{path}: {e}");
                            responder.respond(error_response(500, vec![]));
                        }
                    }
                });
            } else {
                responder.respond(error_response(400, vec![]));
            }
        },
    );
    builder
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
}
