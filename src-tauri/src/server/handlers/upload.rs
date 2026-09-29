//! Stage one uploaded file on disk before transferring it to the destination.

use std::path::{Path, PathBuf};

use axum::{
    extract::{Multipart, State},
    response::Json,
};
use futures::StreamExt;

use crate::rclone::commands::upload::{UploadBatchParams, execute_upload_batch};
use crate::server::state::{ApiResponse, AppError, WebServerState};

pub async fn stream_upload_handler(
    State(state): State<WebServerState>,
    multipart: Multipart,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let (staging, params) = stage_upload(multipart).await?;
    // Once staging completes, a browser disconnect must not interrupt a remote
    // transfer and leave its job permanently running. The task owns its files.
    let result = crate::utils::spawn(async move {
        let result = execute_upload_batch(state.app_handle, params).await;
        drop(staging);
        result
    })
    .await
    .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?
    .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
    Ok(Json(ApiResponse::success(result)))
}

async fn stage_upload(
    multipart: Multipart,
) -> Result<(tempfile::TempDir, UploadBatchParams), AppError> {
    let staging = tempfile::Builder::new()
        .prefix("rclone_upload_")
        .tempdir()
        .map_err(upload_io_error)?;
    stage_upload_in(multipart, staging).await
}

async fn stage_upload_in(
    mut multipart: Multipart,
    staging: tempfile::TempDir,
) -> Result<(tempfile::TempDir, UploadBatchParams), AppError> {
    let (mut remote, mut path) = (String::new(), String::new());
    let mut origin = None;
    let mut group = None;
    let mut mtime = None;
    let mut file_count = 0u32;
    let mut empty_dirs = Vec::new();

    while let Some(field) = multipart.next_field().await.map_err(bad_request)? {
        match field.name().unwrap_or_default() {
            "remote" => remote = field.text().await.map_err(bad_request)?,
            "path" => path = field.text().await.map_err(bad_request)?,
            "origin" => {
                origin = Some(
                    serde_json::from_str(&field.text().await.map_err(bad_request)?)
                        .map_err(bad_request)?,
                )
            }
            "group" => group = Some(field.text().await.map_err(bad_request)?),
            "mtime" => {
                mtime = Some(
                    field
                        .text()
                        .await
                        .map_err(bad_request)?
                        .parse::<i64>()
                        .map_err(bad_request)?,
                )
            }
            // Old clients must reload instead of receiving a false batch success.
            "batchId" | "fileIndex" | "totalFiles" | "jobId" => {
                return Err(bad_request("Legacy upload batch; reload the application"));
            }
            "emptyDirs" => {
                empty_dirs.push(field.text().await.map_err(bad_request)?);
            }
            "file" => {
                let relative = validate_filename(field.file_name().unwrap_or("unnamed"))?;
                let destination = staging.path().join(relative);
                if let Some(parent) = destination.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(upload_io_error)?;
                }
                write_field_to_file(field, &destination, mtime.take()).await?;
                file_count += 1;
            }
            _ => {}
        }
    }
    if file_count == 0 && empty_dirs.is_empty() {
        return Err(bad_request("No file found"));
    }
    let mut local_paths = Vec::new();
    if file_count > 0 {
        let mut entries = tokio::fs::read_dir(staging.path())
            .await
            .map_err(upload_io_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(upload_io_error)? {
            local_paths.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok((
        staging,
        UploadBatchParams {
            remote,
            path,
            local_paths,
            origin,
            group,
            existing_jobid: None,
            no_cache: false,
            empty_dirs,
        },
    ))
}

fn upload_io_error(error: std::io::Error) -> AppError {
    let message = if error.kind() == std::io::ErrorKind::StorageFull {
        crate::localized_error!("backendErrors.file.diskFull")
    } else {
        crate::localized_error!("backendErrors.request.failed", "error" => error.to_string())
    };
    AppError::InternalServerError(anyhow::Error::msg(message))
}

fn bad_request(error: impl std::fmt::Display) -> AppError {
    AppError::BadRequest(anyhow::Error::msg(
        crate::localized_error!("backendErrors.request.failed", "error" => error.to_string()),
    ))
}

fn validate_filename(filename: &str) -> Result<PathBuf, AppError> {
    let normalized = filename.replace('\\', "/");
    if normalized
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains([':', '\0']))
    {
        return Err(bad_request("Invalid uploaded filename"));
    }
    Ok(PathBuf::from(normalized))
}

async fn write_field_to_file(
    mut field: axum::extract::multipart::Field<'_>,
    destination: &Path,
    mtime: Option<i64>,
) -> Result<(), AppError> {
    // Reject duplicate paths instead of silently replacing an earlier file.
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await
        .map_err(upload_io_error)?;
    while let Some(chunk) = field.next().await {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk.map_err(bad_request)?)
            .await
            .map_err(upload_io_error)?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(upload_io_error)?;
    if let Some(mtime) = mtime {
        let duration = std::time::Duration::from_millis(mtime.unsigned_abs());
        let time = if mtime < 0 {
            std::time::UNIX_EPOCH.checked_sub(duration)
        } else {
            std::time::UNIX_EPOCH.checked_add(duration)
        }
        .ok_or_else(|| bad_request("Invalid modification time"))?;
        file.into_std()
            .await
            .set_times(std::fs::FileTimes::new().set_modified(time))
            .map_err(upload_io_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_relative_filenames_by_component() {
        for name in [
            "../escape",
            "/absolute",
            "C:\\escape",
            "folder/../escape",
            "folder/./file",
            "",
            "a\0b",
            "folder//file",
        ] {
            assert!(validate_filename(name).is_err(), "{name:?}");
        }
        for name in ["report..txt", "folder/özel file.txt", ".hidden"] {
            assert_eq!(validate_filename(name).unwrap(), PathBuf::from(name));
        }
        assert_eq!(
            validate_filename("folder\\file.txt").unwrap(),
            PathBuf::from("folder/file.txt")
        );
    }
    async fn multipart(fields: &[(&str, Option<&str>, &str)]) -> Multipart {
        use axum::{body::Body, extract::FromRequest, http::Request};
        let mut body = String::new();
        for (name, filename, content) in fields {
            body.push_str(&format!(
                "--test-boundary\r\nContent-Disposition: form-data; name=\"{name}\""
            ));
            if let Some(filename) = filename {
                body.push_str(&format!("; filename=\"{filename}\""));
            }
            body.push_str(&format!("\r\n\r\n{content}\r\n"));
        }
        body.push_str("--test-boundary--\r\n");
        let request = Request::builder()
            .header(
                "content-type",
                "multipart/form-data; boundary=test-boundary",
            )
            .body(Body::from(body))
            .unwrap();
        Multipart::from_request(request, &()).await.unwrap()
    }

    #[tokio::test]
    async fn stages_a_file_with_its_original_path_and_modification_time() {
        let input = multipart(&[
            ("remote", None, "drive:"),
            ("path", None, "destination"),
            ("origin", None, "\"filemanager\""),
            ("mtime", None, "0"),
            ("file", Some("folder/one.txt"), "one"),
            ("group", None, "upload-group"),
        ])
        .await;
        let (staging, params) = stage_upload(input).await.unwrap();
        assert_eq!(params.remote, "drive:");
        assert_eq!(params.path, "destination");
        assert_eq!(params.local_paths.len(), 1);
        assert_eq!(params.group.as_deref(), Some("upload-group"));
        let one = staging.path().join("folder/one.txt");
        assert_eq!(std::fs::read_to_string(&one).unwrap(), "one");
        assert_eq!(
            std::fs::metadata(one).unwrap().modified().unwrap(),
            std::time::UNIX_EPOCH
        );
        let directory = staging.path().to_owned();
        drop(staging);
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn rejects_duplicate_paths_and_batches_without_files() {
        let duplicate = multipart(&[
            ("file", Some("same.txt"), "one"),
            ("file", Some("same.txt"), "two"),
        ])
        .await;
        assert!(stage_upload(duplicate).await.is_err());
        assert!(
            stage_upload(multipart(&[("remote", None, "drive:")]).await)
                .await
                .is_err()
        );
        assert!(
            stage_upload(multipart(&[("batchId", None, "../escape")]).await)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn supports_pre_epoch_modification_time_and_rejects_traversal() {
        let input = multipart(&[("mtime", None, "-1000"), ("file", Some("old.txt"), "old")]).await;
        let (staging, _) = stage_upload(input).await.unwrap();
        assert_eq!(
            std::fs::metadata(staging.path().join("old.txt"))
                .unwrap()
                .modified()
                .unwrap(),
            std::time::UNIX_EPOCH - std::time::Duration::from_secs(1)
        );
        let traversal = multipart(&[("file", Some("../escape"), "bad")]).await;
        assert!(stage_upload(traversal).await.is_err());
    }
    #[test]
    fn disk_full_errors_use_the_existing_translation_key() {
        let error = upload_io_error(std::io::Error::from(std::io::ErrorKind::StorageFull));
        let AppError::InternalServerError(message) = error else {
            panic!("expected IO error")
        };
        assert!(message.to_string().contains("backendErrors.file.diskFull"));
    }
    #[tokio::test]
    async fn invalid_requests_remove_already_staged_files() {
        let staging = tempfile::tempdir().unwrap();
        let directory = staging.path().to_owned();
        let input = multipart(&[
            ("file", Some("first.txt"), "data"),
            ("file", Some("second.txt"), "data"),
        ])
        .await;
        assert!(stage_upload_in(input, staging).await.is_err());
        assert!(!directory.exists());
    }
}
