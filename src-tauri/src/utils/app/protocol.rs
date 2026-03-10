use log::{debug, error};
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
                    Ok(response) => {
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

                        if status.is_success() {
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
                        } else {
                            responder.respond(
                                tauri::http::Response::builder()
                                    .status(status.as_u16())
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(format!("Rclone error: {}", status).into_bytes())
                                    .unwrap(),
                            );
                        }
                    }
                    Err(e) => {
                        error!("❌ Proxy error fetching {}:{} - {}", remote, path, e);
                        responder.respond(
                            tauri::http::Response::builder()
                                .status(500)
                                .header("Access-Control-Allow-Origin", "*")
                                .body(format!("Proxy error: {}", e).into_bytes())
                                .unwrap(),
                        );
                    }
                }
            });
        });

    // -------------------------------------------------------------------------
    // Custom Protocol for Local Files Bypass (Desktop)
    // -------------------------------------------------------------------------
    builder = builder.register_uri_scheme_protocol("local-asset", |_app, request| {
        // 1. Handle CORS Preflight for Angular's HttpClient
        if request.method() == tauri::http::Method::OPTIONS {
            return tauri::http::Response::builder()
                .status(204)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                .header("Access-Control-Allow-Headers", "*") // Required for Angular
                .body(vec![])
                .unwrap();
        }

        let uri = request.uri().to_string();
        debug!("🔍 local-asset protocol handler received URI: {}", uri);

        // Handle the prefix mapping across different OS webviews
        // Safely strip the 'localhost' authority we added in Angular to prevent Tauri parsing panics
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

        // On Windows, the browser might pass an extra leading slash (e.g., /Z:/folder/file.ext)
        #[cfg(target_os = "windows")]
        let decoded_path = {
            let mut decoded_path = decoded_path;
            if decoded_path.starts_with('/') && decoded_path.chars().nth(2) == Some(':') {
                decoded_path = decoded_path[1..].to_string();
            }
            decoded_path
        };

        debug!("🔍 Final decoded path: '{}'", decoded_path);

        // SECURITY 1: Prevent basic path traversal attacks
        if decoded_path.contains("..") {
            error!("❌ Path traversal attempt blocked: '{}'", decoded_path);
            return tauri::http::Response::builder()
                .status(403)
                .header("Access-Control-Allow-Origin", "*")
                .body("Path traversal denied".as_bytes().to_vec())
                .unwrap();
        }

        let file_path = std::path::Path::new(&decoded_path);

        // SECURITY 2: Ensure the target is actually a file, avoiding OS errors when trying to read a directory
        if file_path.is_dir() {
            error!(
                "❌ Attempted to access directory as asset: '{}'",
                decoded_path
            );
            return tauri::http::Response::builder()
                .status(403)
                .header("Access-Control-Allow-Origin", "*")
                .body(
                    "Directories are not supported by the local-asset protocol"
                        .as_bytes()
                        .to_vec(),
                )
                .unwrap();
        }

        // 1. Determine mime type so the browser knows how to render it (image, pdf, etc.)
        let mime_type = mime_guess::from_path(&decoded_path)
            .first_or_octet_stream()
            .to_string();

        // 2. Open the file
        let mut file = match std::fs::File::open(&decoded_path) {
            Ok(f) => f,
            Err(e) => {
                error!("❌ Failed to open local asset '{}': {}", decoded_path, e);
                return tauri::http::Response::builder()
                    .status(404)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(format!("File not found: {}", e).into_bytes())
                    .unwrap();
            }
        };

        let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
        debug!(
            "✅ Opened local asset: {} (size: {} bytes)",
            decoded_path, file_size
        );

        // 3. Handle HTTP 206 Partial Content (Required for <video> tags to stream without crashing)
        let mut start = 0;
        let mut end = if file_size > 0 { file_size - 1 } else { 0 };
        let mut is_range_request = false;

        if let Some(range_val) = request.headers().get("Range").and_then(|v| v.to_str().ok())
            && let Some(stripped) = range_val.strip_prefix("bytes=")
        {
            // Browser requested a byte range; parse start/end values.
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

        // Safety bound: don't read past the end of the file
        if end >= file_size && file_size > 0 {
            end = file_size - 1;
        }

        // Prevent underflow panic if range start > end
        if start > end {
            return tauri::http::Response::builder()
                .status(416) // Range Not Satisfiable
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Range", format!("bytes */{}", file_size))
                .body(vec![])
                .unwrap();
        }

        // Cap chunk size to 2MB to prevent RAM exhaustion on huge MP4s.
        // Even for non-range requests, we must not allocate more than the file size or a reasonable chunk.
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

        // Read exactly the requested bytes into our chunk buffer
        let mut buffer = vec![0; chunk_size];
        if file_size > 0 {
            use std::io::{Read, Seek, SeekFrom};
            if let Err(e) = file.seek(SeekFrom::Start(start)) {
                error!("❌ Seek error in local asset '{}': {}", decoded_path, e);
                return tauri::http::Response::builder()
                    .status(500)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(format!("Seek error: {}", e).into_bytes())
                    .unwrap();
            }
            // We use read_exact, but ignore errors in case EOF is hit early unexpectedly
            let _ = file.read_exact(&mut buffer);
        }

        let response_builder = tauri::http::Response::builder()
            .header(tauri::http::header::CONTENT_TYPE, mime_type)
            .header("Access-Control-Allow-Origin", "*")
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", chunk_size.to_string());

        // FORCE a 206 Partial Content response if it was a Range request OR if we forcefully truncated the payload.
        // WebKit2GTK / GStreamer will fail if a standard GET is truncated but returns 200 OK.
        if (is_range_request || is_truncated) && file_size > 0 {
            response_builder
                .status(206)
                .header(
                    "Content-Range",
                    format!("bytes {}-{}/{}", start, end, file_size),
                )
                .body(buffer)
                .unwrap()
        } else {
            response_builder.status(200).body(buffer).unwrap()
        }
    });

    builder
}
