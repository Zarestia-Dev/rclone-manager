use std::io::SeekFrom;
use std::path::Path;

use log::{debug, error, warn};
use tauri::{Builder, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::utils::app::audio;
use crate::utils::io::http_helpers::{
    MAX_AUDIO_COVER_PROBE_BYTES, classify_error_status, decode_remote_name, normalize_asset_path,
    parse_byte_range, strip_protocol_prefix, strip_protocol_prefix_trimmed, url_decode,
};
use crate::utils::types::state::RcloneState;

pub fn register_protocols<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder = register_rclone_protocol(builder);
    builder = register_local_asset_protocol(builder);
    builder = register_audio_cover_protocol(builder);
    builder
}

fn cors_preflight_response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(204)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
        .header("Access-Control-Allow-Headers", "*")
        .body(vec![])
        .unwrap()
}

/// Helper to construct a standard CORS-enabled error/status HTTP response.
pub fn error_response(
    status: impl TryInto<tauri::http::StatusCode>,
    body: impl Into<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let status_code = status
        .try_into()
        .unwrap_or(tauri::http::StatusCode::INTERNAL_SERVER_ERROR);
    tauri::http::Response::builder()
        .status(status_code)
        .header("Access-Control-Allow-Origin", "*")
        .body(body.into())
        .unwrap()
}

fn register_rclone_protocol<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder =
        builder.register_asynchronous_uri_scheme_protocol("rclone", |app, request, responder| {
            if request.method() == tauri::http::Method::OPTIONS {
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
                let rclone_state = app_handle.state::<crate::utils::types::state::RcloneState>();
                let transport = rclone_state.transport.clone();

                let byte_range = range_header.as_deref().and_then(parse_byte_range);
                let mime_type = mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .to_string();

                match transport.read_file(&remote, &path, byte_range).await {
                    Ok(mut reader) => {
                        let mut bytes = Vec::new();
                        match reader.read_to_end(&mut bytes).await {
                            Ok(_) => {
                                let mut builder = tauri::http::Response::builder()
                                    .status(if byte_range.is_some() { 206 } else { 200 })
                                    .header(tauri::http::header::CONTENT_TYPE, mime_type)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Accept-Ranges", "bytes");

                                if let Some(rh) = range_header.as_deref() {
                                    builder = builder.header("Content-Range", rh);
                                }

                                responder.respond(builder.body(bytes).unwrap());
                            }
                            Err(e) => {
                                error!("Stream read error for {remote}:{path}: {e}");
                                responder.respond(error_response(
                                    500,
                                    format!("Stream read error: {e}"),
                                ));
                            }
                        }
                    }
                    Err(e) => {
                        error!("read_file failed for {remote}:{path}: {e}");
                        let err_str = e.to_string();
                        let status = classify_error_status(&err_str);
                        responder.respond(error_response(status, err_str));
                    }
                }
            });
        });
    builder
}

fn register_local_asset_protocol<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder =
        builder.register_asynchronous_uri_scheme_protocol("local-asset", |app, request, responder| {
            if request.method() == tauri::http::Method::OPTIONS {
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
            if final_path.contains("..") {
                error!("❌ Path traversal attempt blocked: '{final_path}'");
                responder.respond(error_response(403, "Path traversal denied"));
                return;
            }

            // Android path alias mapping (/sdcard/ -> /storage/emulated/0/)
            if final_path.starts_with("/sdcard/") {
                let alt_path = final_path.replacen("/sdcard/", "/storage/emulated/0/", 1);
                if std::path::Path::new(&alt_path).exists() {
                    final_path = alt_path;
                }
            }

            let file_path = std::path::Path::new(&final_path);

            // SECURITY 2: Ensure the target is actually a file
            if file_path.is_dir() {
                error!("❌ Attempted to access directory as asset: '{final_path}'");
                responder.respond(error_response(
                    403,
                    "Directories are not supported by the local-asset protocol",
                ));
                return;
            }

            // Determine mime type
            let mime_type = mime_guess::from_path(&final_path)
                .first_or_octet_stream()
                .to_string();

            let app_handle = app.app_handle().clone();

            // Use async runtime to support cat fallback
            crate::utils::spawn(async move {
                let byte_range = request
                    .headers()
                    .get("Range")
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_byte_range);

                // Try to open the file directly using non-blocking tokio::fs
                match tokio::fs::File::open(&final_path).await {
                    Ok(mut file) => {
                        let file_size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
                        debug!("✅ Opened local asset: {final_path} (size: {file_size} bytes)");

                        if let Some((start, end_opt)) = byte_range
                            && file_size > 0
                        {
                            let mut end = end_opt.unwrap_or(file_size - 1);
                            if end >= file_size {
                                end = file_size - 1;
                            }

                            if start > end {
                                responder.respond(
                                    tauri::http::Response::builder()
                                        .status(416)
                                        .header("Access-Control-Allow-Origin", "*")
                                        .header("Content-Range", format!("bytes */{file_size}"))
                                        .body(vec![])
                                        .unwrap(),
                                );
                                return;
                            }

                            let chunk_size = (end - start + 1) as usize;
                            let mut buffer = vec![0; chunk_size];
                            if let Err(e) = file.seek(SeekFrom::Start(start)).await {
                                error!("❌ Seek error in local asset '{final_path}': {e}");
                                responder.respond(error_response(500, format!("Seek error: {e}")));
                                return;
                            }
                            if let Err(e) = file.read_exact(&mut buffer).await {
                                error!("❌ Read error in local asset '{final_path}': {e}");
                                responder.respond(error_response(500, format!("Read error: {e}")));
                                return;
                            }

                            responder.respond(
                                tauri::http::Response::builder()
                                    .status(206)
                                    .header(tauri::http::header::CONTENT_TYPE, &mime_type)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Accept-Ranges", "bytes")
                                    .header(
                                        "Content-Range",
                                        format!("bytes {start}-{end}/{file_size}"),
                                    )
                                    .header("Content-Length", chunk_size.to_string())
                                    .body(buffer)
                                    .unwrap(),
                            );
                        } else {
                            let mut buffer = Vec::with_capacity(file_size as usize);
                            if file_size > 0
                                && let Err(e) = file.read_to_end(&mut buffer).await
                            {
                                error!("❌ Read error in local asset '{final_path}': {e}");
                                responder.respond(error_response(500, format!("Read error: {e}")));
                                return;
                            }

                            responder.respond(
                                tauri::http::Response::builder()
                                    .status(200)
                                    .header(tauri::http::header::CONTENT_TYPE, &mime_type)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Accept-Ranges", "bytes")
                                    .header("Content-Length", buffer.len().to_string())
                                    .body(buffer)
                                    .unwrap(),
                            );
                        }
                    }
                    Err(e) => {
                        warn!("Standard open failed for local asset {final_path}, attempting transport fallback: {e}");

                        let rclone_state = app_handle.state::<RcloneState>();
                        let transport = rclone_state.transport.clone();

                        match transport.read_file("", &final_path, byte_range).await {
                            Ok(mut reader) => {
                                let mut bytes = Vec::new();
                                match reader.read_to_end(&mut bytes).await {
                                    Ok(_) => {
                                        let mut builder = tauri::http::Response::builder()
                                            .status(if byte_range.is_some() { 206 } else { 200 })
                                            .header(tauri::http::header::CONTENT_TYPE, &mime_type)
                                            .header("Access-Control-Allow-Origin", "*");

                                        if let Some(rh) = request
                                            .headers()
                                            .get("Range")
                                            .and_then(|v| v.to_str().ok())
                                        {
                                            builder = builder.header("Content-Range", rh);
                                        }

                                        responder.respond(builder.body(bytes).unwrap());
                                    }
                                    Err(read_err) => {
                                        error!("Transport read failed for {final_path}: {read_err}");
                                        responder.respond(error_response(
                                            500,
                                            format!("Read error: {read_err}"),
                                        ));
                                    }
                                }
                            }
                            Err(cat_err) => {
                                error!("Local transport fallback failed for {final_path}: {cat_err}");
                                let err_str = cat_err.to_string();
                                let status = classify_error_status(&err_str);
                                responder.respond(error_response(status, err_str));
                            }
                        }
                    }
                }
            });
        });
    builder
}

fn register_audio_cover_protocol<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    builder = builder.register_asynchronous_uri_scheme_protocol(
        "audio-cover",
        |app, request, responder| {
            if request.method() == tauri::http::Method::OPTIONS {
                responder.respond(cors_preflight_response());
                return;
            }

            let uri = request.uri().to_string();
            debug!("🔍 audio-cover protocol handler received URI: {uri}");
            let path_part = strip_protocol_prefix_trimmed(&uri, "audio-cover");

            if let Some(local_path) = path_part.strip_prefix("local/") {
                // Local file extraction
                let decoded_path = normalize_asset_path(url_decode(local_path));

                if let Some(pic) = audio::extract_picture_from_path(&decoded_path) {
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(200)
                            .header(tauri::http::header::CONTENT_TYPE, pic.mime_type)
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Cache-Control", "max-age=3600")
                            .body(pic.data)
                            .unwrap(),
                    );
                } else {
                    responder.respond(error_response(404, vec![]));
                }
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
                        app_handle.state::<crate::utils::types::state::RcloneState>();
                    let transport = rclone_state.transport.clone();

                    match transport
                        .read_file(&remote, &path, Some((0, Some(MAX_AUDIO_COVER_PROBE_BYTES))))
                        .await
                    {
                        Ok(mut reader) => {
                            let mut bytes = Vec::new();
                            if reader.read_to_end(&mut bytes).await.is_ok() && !bytes.is_empty() {
                                let extension =
                                    Path::new(&path).extension().and_then(|ext| ext.to_str());
                                if let Some(pic) =
                                    audio::extract_picture_from_bytes(&bytes, extension)
                                {
                                    responder.respond(
                                        tauri::http::Response::builder()
                                            .status(200)
                                            .header(
                                                tauri::http::header::CONTENT_TYPE,
                                                pic.mime_type,
                                            )
                                            .header("Access-Control-Allow-Origin", "*")
                                            .header("Cache-Control", "max-age=3600")
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

    #[test]
    fn test_error_response() {
        let resp = error_response(tauri::http::StatusCode::NOT_FOUND, "not found text");
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
