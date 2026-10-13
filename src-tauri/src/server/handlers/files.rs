//! File operation handlers (streaming, etc.)

use std::io::SeekFrom;
use std::path::PathBuf;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use serde::Deserialize;
use tauri::Manager;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::server::state::{AppError, WebServerState};
use crate::utils::io::http_helpers::{
    classify_error_status, content_disposition, decode_remote_name, normalize_asset_path,
    parse_byte_range,
};
use crate::utils::types::state::RcloneState;

#[derive(Deserialize)]
pub struct StreamRemoteFileQuery {
    pub remote: String,
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_remote_file_handler(
    State(state): State<WebServerState>,
    headers: HeaderMap,
    Query(query): Query<StreamRemoteFileQuery>,
) -> Result<impl IntoResponse, AppError> {
    if query.path.contains("..") {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Path traversal denied"
        )));
    }

    let byte_range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_byte_range);

    let remote = decode_remote_name(&query.remote);

    let rclone_state = state.app_handle.state::<RcloneState>();
    let transport = rclone_state.transport.clone();

    let reader = transport
        .read_file(&remote, &query.path, byte_range)
        .await
        .map_err(|e| {
            let err_msg = e.to_string();
            let status = classify_error_status(&err_msg);
            match status {
                StatusCode::NOT_FOUND => AppError::NotFound(err_msg),
                StatusCode::LOCKED | StatusCode::FORBIDDEN => {
                    AppError::BadRequest(anyhow::anyhow!(err_msg))
                }
                _ => AppError::InternalServerError(anyhow::anyhow!(err_msg)),
            }
        })?;

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
        None,
    )
}

#[derive(Deserialize)]
pub struct StreamFileQuery {
    pub path: String,
    pub download: Option<bool>,
}

pub async fn stream_file_handler(
    State(state): State<WebServerState>,
    headers: HeaderMap,
    Query(query): Query<StreamFileQuery>,
) -> Result<impl IntoResponse, AppError> {
    let path_str = normalize_asset_path(query.path);

    if path_str.contains("..") {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Path traversal denied"
        )));
    }

    let path = PathBuf::from(&path_str);

    if path.is_dir() {
        return Err(AppError::BadRequest(anyhow::anyhow!(
            "Directories cannot be streamed as files"
        )));
    }

    let byte_range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_byte_range);

    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let mime_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();

    // Try standard local file opening first
    let file_result = if path.exists() {
        File::open(&path).await.map_err(anyhow::Error::msg)
    } else {
        Err(anyhow::anyhow!(
            "File not found or inaccessible via std::fs"
        ))
    };

    match file_result {
        Ok(mut file) => {
            let metadata = file.metadata().await.map_err(anyhow::Error::msg)?;
            let total_len = metadata.len();

            if let Some((start, end_opt)) = byte_range {
                if start >= total_len {
                    return axum::response::Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{total_len}"))
                        .body(axum::body::Body::empty())
                        .map_err(|e| {
                            AppError::InternalServerError(anyhow::anyhow!(e.to_string()))
                        });
                }

                file.seek(SeekFrom::Start(start))
                    .await
                    .map_err(anyhow::Error::msg)?;

                let count = match end_opt {
                    Some(end) if end >= start && end < total_len => end - start + 1,
                    _ => total_len - start,
                };

                let body = axum::body::Body::from_stream(ReaderStream::new(file.take(count)));
                build_stream_response(
                    body,
                    &filename,
                    &mime_type,
                    query.download.unwrap_or(false),
                    Some((start, end_opt)),
                    Some(total_len),
                )
            } else {
                let body = axum::body::Body::from_stream(ReaderStream::new(file));
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

            match transport.read_file("", &path_str, byte_range).await {
                Ok(reader) => {
                    let body = axum::body::Body::from_stream(ReaderStream::new(reader));
                    build_stream_response(
                        body,
                        &filename,
                        &mime_type,
                        query.download.unwrap_or(false),
                        byte_range,
                        None,
                    )
                }
                Err(cat_err) => {
                    log::error!("❌ Cat fallback also failed for {}: {}", path_str, cat_err);

                    let err_msg = cat_err.to_string();
                    let status = classify_error_status(&err_msg);
                    match status {
                        StatusCode::NOT_FOUND => Err(AppError::NotFound(err_msg)),
                        StatusCode::LOCKED | StatusCode::FORBIDDEN => {
                            Err(AppError::BadRequest(anyhow::anyhow!(err_msg)))
                        }
                        _ => Err(AppError::InternalServerError(anyhow::anyhow!(err_msg))),
                    }
                }
            }
        }
    }
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
        } else if let Some(end) = end_opt {
            let length = end.saturating_sub(start) + 1;
            builder = builder
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/*"))
                .header(header::CONTENT_LENGTH, length.to_string());
        } else {
            builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-/*"));
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
}
