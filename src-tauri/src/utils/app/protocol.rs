use crate::utils::app::audio;
use log::{debug, error, warn};
use std::path::Path;
use tauri::{Builder, Manager, Runtime};

pub fn register_protocols<R: Runtime>(mut builder: Builder<R>) -> Builder<R> {
    // -------------------------------------------------------------------------
    // Custom Protocol for Remote File Streaming (Desktop)
    // -------------------------------------------------------------------------
    builder =
        builder.register_asynchronous_uri_scheme_protocol("rclone", |app, request, responder| {
            // 1. Handle CORS Preflight for Angular's HttpClient
            if request.method() == tauri::http::Method::OPTIONS {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(204)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .body(vec![])
                        .unwrap(),
                );
                return;
            }

            // capture an incoming Range header so we can forward it later
            let range_header = request
                .headers()
                .get("Range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let uri = request.uri().to_string();
            // On Linux/macOS (WebKit) the URI is "rclone://remote/path".
            // On Windows (WebView2), frontend sends "http://rclone.localhost/remote/path"
            // but WebView2 transforms it to "rclone://localhost/remote/path" when routing to handler.
            debug!("🔍 rclone protocol handler received URI: {}", uri);
            let path_part = if let Some(stripped) = uri.strip_prefix("rclone://localhost/") {
                // Windows WebView2 format after transformation
                stripped
            } else if let Some(stripped) = uri.strip_prefix("rclone://") {
                // Unix format
                stripped
            } else if let Some(stripped) = uri.strip_prefix("http://rclone.localhost/") {
                // Fallback if WebView2 doesn't transform
                stripped
            } else {
                &uri
            };

            // Find the first slash to separate remote from path
            let (remote, path) = match path_part.find('/') {
                Some(idx) => (&path_part[..idx], &path_part[idx + 1..]),
                None => (path_part, ""),
            };

            let app_handle = app.app_handle().clone();
            let remote = match urlencoding::decode(remote) {
                Ok(decoded) => {
                    let mut r = decoded.into_owned();
                    // Restore the trailing colon stripped from the URL host by the frontend
                    // (rclone remote names have the format "name:", but colons are invalid
                    // in URL hostnames so the frontend omits it)
                    if !r.ends_with(':') {
                        r.push(':');
                    }
                    r
                }
                Err(_) => {
                    let mut r = remote.to_string();
                    if !r.ends_with(':') {
                        r.push(':');
                    }
                    r
                }
            };
            let path = match urlencoding::decode(path) {
                Ok(decoded) => decoded.into_owned(),
                Err(_) => path.to_string(),
            };

            debug!("🔍 Parsed remote: '{}', path: '{}'", remote, path);

            tauri::async_runtime::spawn(async move {
                use crate::rclone::backend::BackendManager;
                let backend_manager = app_handle.state::<BackendManager>();
                let backend: crate::rclone::backend::types::Backend =
                    backend_manager.get_active().await;

                let rclone_state = app_handle.state::<crate::utils::types::core::RcloneState>();
                let client = &rclone_state.client;

                // forward Range header to rclone so we only fetch the requested bytes
                match backend
                    .fetch_file_stream_with_range(client, &remote, &path, range_header.as_deref())
                    .await
                {
                    Ok(response) if response.status().is_success() => {
                        let status = response.status();
                        let is_range_response = status == reqwest::StatusCode::PARTIAL_CONTENT;
                        let content_type = response
                            .headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("application/octet-stream")
                            .to_string();
                        let content_range = response
                            .headers()
                            .get(reqwest::header::CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        let content_length = response
                            .headers()
                            .get(reqwest::header::CONTENT_LENGTH)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        let accept_ranges = response
                            .headers()
                            .get(reqwest::header::ACCEPT_RANGES)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("bytes")
                            .to_string();

                        match response.bytes().await {
                            Ok(bytes) => {
                                let mut builder = tauri::http::Response::builder()
                                    .status(if is_range_response { 206 } else { 200 })
                                    .header(tauri::http::header::CONTENT_TYPE, content_type)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Accept-Ranges", accept_ranges);

                                if let Some(cr) = content_range {
                                    builder = builder.header("Content-Range", cr);
                                }
                                if let Some(cl) = content_length {
                                    builder = builder.header("Content-Length", cl);
                                }

                                responder.respond(builder.body(bytes.to_vec()).unwrap());
                            }
                            Err(e) => {
                                error!("❌ Stream read error for {}: {}", remote, e);
                                responder.respond(
                                    tauri::http::Response::builder()
                                        .status(500)
                                        .header("Access-Control-Allow-Origin", "*")
                                        .body(format!("Stream read error: {}", e).into_bytes())
                                        .unwrap(),
                                );
                            }
                        }
                    }
                    _ => {
                        // Fallback to cat via core/command
                        debug!(
                            "⚠️ Standard stream failed, attempting cat fallback for {}:{}",
                            remote, path
                        );
                        let (offset, count) = range_header
                            .as_ref()
                            .map(|rh| parse_range_header(rh))
                            .unwrap_or((None, None));

                        let os = backend_manager.get_runtime_os(&backend.name).await;

                        // Guess mime type for cat fallback
                        let mime_type = mime_guess::from_path(&path)
                            .first_or_octet_stream()
                            .to_string();

                        match backend
                            .fetch_file_via_cat(client, &remote, &path, offset, count, os)
                            .await
                        {
                            Ok(bytes) => {
                                let mut builder = tauri::http::Response::builder()
                                    .status(if offset.is_some() { 206 } else { 200 })
                                    .header(tauri::http::header::CONTENT_TYPE, mime_type)
                                    .header("Access-Control-Allow-Origin", "*");

                                if let Some(rh) = range_header {
                                    builder = builder.header("Content-Range", rh);
                                }

                                responder.respond(builder.body(bytes).unwrap());
                            }
                            Err(e) => {
                                error!(
                                    "❌ Cat fallback also failed for {}:{} - {}",
                                    remote, path, e
                                );

                                let status = if e.contains("not found")
                                    || e.contains("directory not found")
                                {
                                    tauri::http::StatusCode::NOT_FOUND
                                } else if e.contains("being used by another process")
                                    || e.contains("locked")
                                {
                                    tauri::http::StatusCode::LOCKED
                                } else if e.contains("Access is denied")
                                    || e.contains("permission denied")
                                {
                                    tauri::http::StatusCode::FORBIDDEN
                                } else {
                                    tauri::http::StatusCode::INTERNAL_SERVER_ERROR
                                };

                                responder.respond(
                                    tauri::http::Response::builder()
                                        .status(status)
                                        .header("Access-Control-Allow-Origin", "*")
                                        .body(e.into_bytes())
                                        .unwrap(),
                                );
                            }
                        }
                    }
                }
            });
        });

    // -------------------------------------------------------------------------
    // Custom Protocol for Local Files Bypass (Desktop)
    // -------------------------------------------------------------------------
    builder = builder.register_asynchronous_uri_scheme_protocol("local-asset", |app, request, responder| {
        // 1. Handle CORS Preflight for Angular's HttpClient
        if request.method() == tauri::http::Method::OPTIONS {
            responder.respond(tauri::http::Response::builder()
                .status(204)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                .header("Access-Control-Allow-Headers", "*") // Required for Angular
                .body(vec![])
                .unwrap());
            return;
        }

        let uri = request.uri().to_string();
        debug!("🔍 local-asset protocol handler received URI: {}", uri);

        // Handle the prefix mapping across different OS webviews
        let path_part = if let Some(stripped) = uri.strip_prefix("local-asset://localhost") {
            stripped // Leaves the leading slash, e.g., "/home/user"
        } else if let Some(stripped) = uri.strip_prefix("http://local-asset.localhost") {
            stripped
        } else if let Some(stripped) = uri.strip_prefix("local-asset://") {
            stripped
        } else {
            &uri
        };

        // Decode URL encoding (e.g., %20 to space)
        let decoded_path = match urlencoding::decode(path_part) {
            Ok(decoded) => decoded.into_owned(),
            Err(_) => path_part.to_string(),
        };

        // Strip leading slash if it looks like a Windows drive path (e.g., /C:/folder)
        // This is now done at runtime for all platforms to handle cases where
        // Windows-style paths are passed to a Linux manager.
        let mut final_path = decoded_path;
        if final_path.starts_with('/') && final_path.chars().nth(2) == Some(':') {
            final_path = final_path[1..].to_string();
        }

        debug!("🔍 Final decoded path: '{}'", final_path);

        // SECURITY 1: Prevent basic path traversal attacks
        if final_path.contains("..") {
            error!("❌ Path traversal attempt blocked: '{}'", final_path);
            responder.respond(tauri::http::Response::builder()
                .status(403)
                .header("Access-Control-Allow-Origin", "*")
                .body("Path traversal denied".as_bytes().to_vec())
                .unwrap());
            return;
        }

        let file_path = std::path::Path::new(&final_path);

        // SECURITY 2: Ensure the target is actually a file
        if file_path.is_dir() {
            error!(
                "❌ Attempted to access directory as asset: '{}'",
                final_path
            );
            responder.respond(tauri::http::Response::builder()
                .status(403)
                .header("Access-Control-Allow-Origin", "*")
                .body(
                    "Directories are not supported by the local-asset protocol"
                        .as_bytes()
                        .to_vec(),
                )
                .unwrap());
            return;
        }

        // 1. Determine mime type
        let mime_type = mime_guess::from_path(&final_path)
            .first_or_octet_stream()
            .to_string();

        let app_handle = app.app_handle().clone();
        let final_path_clone = final_path.clone();
        let mime_type_clone = mime_type.clone();

        // Use async runtime to support cat fallback
        tauri::async_runtime::spawn(async move {
            use std::io::{Read, Seek, SeekFrom};
            use crate::rclone::backend::BackendManager;
            use crate::utils::types::core::RcloneState;

            // 2. Try to open the file directly
            match std::fs::File::open(&final_path_clone) {
                Ok(mut file) => {
                    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
                    debug!(
                        "✅ Opened local asset: {} (size: {} bytes)",
                        final_path_clone, file_size
                    );

                    // 3. Handle HTTP 206 Partial Content
                    let mut start = 0;
                    let mut end = if file_size > 0 { file_size - 1 } else { 0 };
                    let mut is_range_request = false;

                    if let Some(range_val) = request.headers().get("Range").and_then(|v| v.to_str().ok())
                        && let Some(stripped) = range_val.strip_prefix("bytes=")
                    {
                        is_range_request = true;
                        let parts: Vec<&str> = stripped.split('-').collect();
                        if let Some(s) = parts.first().and_then(|s| s.parse::<u64>().ok()) {
                            start = s;
                        }
                        if parts.len() > 1
                            && !parts[1].is_empty()
                            && let Ok(e) = parts[1].parse::<u64>()
                        {
                            end = e;
                        }
                    }

                    if end >= file_size && file_size > 0 {
                        end = file_size - 1;
                    }

                    if start > end {
                        responder.respond(tauri::http::Response::builder()
                            .status(416) // Range Not Satisfiable
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Content-Range", format!("bytes */{}", file_size))
                            .body(vec![])
                            .unwrap());
                        return;
                    }

                    let max_chunk_size = 2 * 1024 * 1024;
                    let mut chunk_size = if file_size > 0 {
                        (end - start + 1) as usize
                    } else {
                        0
                    };

                    let mut is_truncated = false;
                    if chunk_size > max_chunk_size {
                        chunk_size = max_chunk_size;
                        end = start + chunk_size as u64 - 1;
                        is_truncated = true;
                    }

                    let mut buffer = vec![0; chunk_size];
                    if file_size > 0 {
                        if let Err(e) = file.seek(SeekFrom::Start(start)) {
                            error!("❌ Seek error in local asset '{}': {}", final_path_clone, e);
                            responder.respond(tauri::http::Response::builder()
                                .status(500)
                                .header("Access-Control-Allow-Origin", "*")
                                .body(format!("Seek error: {}", e).into_bytes())
                                .unwrap());
                            return;
                        }
                        let _ = file.read_exact(&mut buffer);
                    }

                    let response_builder = tauri::http::Response::builder()
                        .header(tauri::http::header::CONTENT_TYPE, mime_type_clone)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Accept-Ranges", "bytes")
                        .header("Content-Length", chunk_size.to_string());

                    if (is_range_request || is_truncated) && file_size > 0 {
                        responder.respond(response_builder
                            .status(206)
                            .header(
                                "Content-Range",
                                format!("bytes {}-{}/{}", start, end, file_size),
                            )
                            .body(buffer)
                            .unwrap());
                    } else {
                        responder.respond(response_builder.status(200).body(buffer).unwrap());
                    }
                }
                Err(e) => {
                    // 4. Fallback to rclone cat
                    debug!("⚠️ Standard open failed for local asset {}, attempting cat fallback: {}", final_path_clone, e);

                    let backend_manager = app_handle.state::<BackendManager>();
                    let backend = backend_manager.get_active().await;
                    let rclone_state = app_handle.state::<RcloneState>();

                    // Parse range for cat if available
                    let (offset, count) = request.headers().get("Range")
                        .and_then(|v| v.to_str().ok())
                        .map(parse_range_header)
                        .unwrap_or((None, None));

                    let os = backend_manager.get_runtime_os(&backend.name).await;

                    match backend.fetch_file_via_cat(&rclone_state.client, "", &final_path_clone, offset, count, os).await {
                        Ok(bytes) => {
                            let mut builder = tauri::http::Response::builder()
                                .status(if offset.is_some() { 206 } else { 200 })
                                .header(tauri::http::header::CONTENT_TYPE, mime_type_clone)
                                .header("Access-Control-Allow-Origin", "*");

                            if let Some(rh) = request.headers().get("Range").and_then(|v| v.to_str().ok()) {
                                builder = builder.header("Content-Range", rh);
                            }

                            responder.respond(builder.body(bytes).unwrap());
                        }
                        Err(cat_err) => {
                            error!("❌ Local cat fallback failed for {}: {}", final_path_clone, cat_err);

                            let status = if cat_err.contains("not found") || cat_err.contains("directory not found") {
                                tauri::http::StatusCode::NOT_FOUND
                            } else if cat_err.contains("being used by another process") {
                                tauri::http::StatusCode::LOCKED
                            } else if cat_err.contains("Access is denied") || cat_err.contains("permission denied") {
                                tauri::http::StatusCode::FORBIDDEN
                            } else {
                                tauri::http::StatusCode::INTERNAL_SERVER_ERROR
                            };

                            responder.respond(tauri::http::Response::builder()
                                .status(status)
                                .header("Access-Control-Allow-Origin", "*")
                                .body(cat_err.into_bytes())
                                .unwrap());
                        }
                    }
                }
            }
        });
    });

    // -------------------------------------------------------------------------
    // Custom Protocol for Audio Cover Extraction (Desktop)
    // -------------------------------------------------------------------------
    builder = builder.register_asynchronous_uri_scheme_protocol(
        "audio-cover",
        |app, request, responder| {
            // 1. Handle CORS Preflight
            if request.method() == tauri::http::Method::OPTIONS {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(204)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .body(vec![])
                        .unwrap(),
                );
                return;
            }

            let uri = request.uri().to_string();
            debug!("🔍 audio-cover protocol handler received URI: {}", uri);

            // Expected formats:
            // audio-cover://localhost/local/<path>
            // audio-cover://localhost/remote/<remote>/<path>

            let path_part = if let Some(stripped) = uri.strip_prefix("audio-cover://localhost/") {
                stripped
            } else if let Some(stripped) = uri.strip_prefix("http://audio-cover.localhost/") {
                stripped
            } else if let Some(stripped) = uri.strip_prefix("audio-cover://") {
                stripped
            } else {
                &uri
            };

            if let Some(local_path) = path_part.strip_prefix("local/") {
                // Local file extraction
                let decoded_path = match urlencoding::decode(local_path) {
                    Ok(decoded) => decoded.into_owned(),
                    Err(_) => local_path.to_string(),
                };

                #[cfg(target_os = "windows")]
                let decoded_path = {
                    if decoded_path.starts_with('/') && decoded_path.chars().nth(2) == Some(':') {
                        decoded_path[1..].to_string()
                    } else {
                        decoded_path
                    }
                };

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
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(404)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(vec![])
                            .unwrap(),
                    );
                }
            } else if let Some(remote_part) = path_part.strip_prefix("remote/") {
                // Remote file extraction
                let (remote_enc, path_enc) = match remote_part.find('/') {
                    Some(idx) => (&remote_part[..idx], &remote_part[idx + 1..]),
                    None => (remote_part, ""),
                };

                let mut remote = match urlencoding::decode(remote_enc) {
                    Ok(d) => d.into_owned(),
                    Err(_) => remote_enc.to_string(),
                };
                if !remote.ends_with(':') {
                    remote.push(':');
                }

                let path = match urlencoding::decode(path_enc) {
                    Ok(d) => d.into_owned(),
                    Err(_) => path_enc.to_string(),
                };

                let app_handle = app.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    use crate::rclone::backend::BackendManager;
                    let backend_manager = app_handle.state::<BackendManager>();
                    let backend = backend_manager.get_active().await;
                    let rclone_state = app_handle.state::<crate::utils::types::core::RcloneState>();

                    // Fetch first 10MB (consistent with headless handler)
                    match backend
                        .fetch_file_stream_with_range(
                            &rclone_state.client,
                            &remote,
                            &path,
                            Some("bytes=0-10485760"),
                        )
                        .await
                    {
                        Ok(response) => {
                            if response.status().is_success()
                                && let Ok(bytes) = response.bytes().await
                            {
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
                            responder.respond(
                                tauri::http::Response::builder()
                                    .status(404)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(vec![])
                                    .unwrap(),
                            );
                        }
                        Err(e) => {
                            warn!("Failed to fetch remote cover for {remote}:{path}: {e}");
                            responder.respond(
                                tauri::http::Response::builder()
                                    .status(500)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(vec![])
                                    .unwrap(),
                            );
                        }
                    }
                });
            } else {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(400)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(vec![])
                        .unwrap(),
                );
            }
        },
    );

    builder
}

/// Helper to parse a standard HTTP Range header into (offset, count).
/// Format: "bytes=start-end"
fn parse_range_header(range_str: &str) -> (Option<i64>, Option<i64>) {
    if !range_str.starts_with("bytes=") {
        return (None, None);
    }
    let parts: Vec<&str> = range_str[6..].split('-').collect();
    let start = parts.first().and_then(|s| s.parse::<i64>().ok());
    let end = if parts.len() > 1 && !parts[1].is_empty() {
        parts[1].parse::<i64>().ok()
    } else {
        None
    };

    match (start, end) {
        (Some(s), Some(e)) => (Some(s), Some(e - s + 1)),
        (Some(s), None) => (Some(s), None),
        _ => (None, None),
    }
}
