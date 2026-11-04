//! Stage uploaded files on disk before transferring them to the destination.

use std::{
    future::Future,
    path::{Path, PathBuf},
};

use axum::{
    extract::{Multipart, State},
    response::Json,
};
use futures::StreamExt;
use rclone_manager_core::{context::AppHandle, localized_error};

use crate::rclone::commands::upload::{UploadBatchParams, execute_upload_batch};
use crate::web::state::{ApiResponse, AppError, WebServerState};

/// Uploads are staged in the application's cache, not the system temp directory,
/// which is often a small tmpfs.
fn upload_staging_root(app: &AppHandle) -> PathBuf {
    app.state::<crate::services::paths::AppPaths>()
        .cache_dir
        .join("uploads")
}

/// Staging directories are removed when their request ends, so whatever remains
/// was left by a crash.
pub async fn clear_stale_upload_staging(app: &AppHandle) {
    let root = upload_staging_root(app);
    if let Err(error) = tokio::fs::remove_dir_all(&root).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!(
            "Cannot clear stale upload staging {}: {error}",
            root.display()
        );
    }
}

pub async fn stream_upload_handler(
    State(state): State<WebServerState>,
    multipart: Multipart,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let backend = state
        .app_handle
        .state::<crate::rclone::backend::BackendManager>()
        .get_active()
        .await;
    let (staging, mut params) =
        stage_upload(multipart, &upload_staging_root(&state.app_handle)).await?;
    params.backend = Some(backend);
    // Once staging completes, a browser disconnect must not interrupt a remote
    // transfer and leave its job permanently running. The task owns its files.
    let result = crate::utils::spawn(run_then_discard(
        staging,
        execute_upload_batch(state.app_handle, params),
    ))
    .await
    .map_err(AppError::internal)?
    .map_err(AppError::internal)?;
    Ok(Json(ApiResponse::success(result)))
}

/// Removes a staging directory and reports what could not be removed. Dropping
/// a `TempDir` ignores that error and would leave the files behind unnoticed.
async fn discard_staging(staging: tempfile::TempDir) {
    let path = staging.path().to_owned();
    match crate::utils::spawn_blocking(move || staging.close()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("Cannot remove upload staging {}: {error}", path.display()),
        Err(error) => log::warn!("Cannot remove upload staging {}: {error}", path.display()),
    }
}

/// Whatever `work` returns, success or failure, the staged files are gone before
/// its result is reported.
async fn run_then_discard<T>(staging: tempfile::TempDir, work: impl Future<Output = T>) -> T {
    let result = work.await;
    discard_staging(staging).await;
    result
}

/// Stages a request under `root`. When it fails, nothing it wrote remains, so a
/// full disk or a dropped connection does not leave partial files behind.
async fn stage_upload(
    multipart: Multipart,
    root: &Path,
) -> Result<(tempfile::TempDir, UploadBatchParams), AppError> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(upload_io_error)?;
    let staging = tempfile::Builder::new()
        .prefix("rclone_upload_")
        .tempdir_in(root)
        .map_err(upload_io_error)?;
    match stage_upload_in(multipart, staging.path()).await {
        Ok(params) => Ok((staging, params)),
        Err(error) => {
            discard_staging(staging).await;
            Err(error)
        }
    }
}

async fn stage_upload_in(
    mut multipart: Multipart,
    staging: &Path,
) -> Result<UploadBatchParams, AppError> {
    let (mut remote, mut path) = (String::new(), String::new());
    let mut origin = None;
    let mut group = None;
    let mut mtime = None;
    let mut file_count = 0u32;
    let mut empty_dirs = Vec::new();

    while let Some(field) = multipart.next_field().await.map_err(request_failed)? {
        match field.name().unwrap_or_default() {
            "remote" => remote = field.text().await.map_err(request_failed)?,
            "path" => path = field.text().await.map_err(request_failed)?,
            "origin" => {
                origin = Some(
                    serde_json::from_str(&field.text().await.map_err(request_failed)?)
                        .map_err(request_failed)?,
                )
            }
            "group" => group = Some(field.text().await.map_err(request_failed)?),
            "mtime" => {
                mtime = Some(
                    field
                        .text()
                        .await
                        .map_err(request_failed)?
                        .parse::<i64>()
                        .map_err(request_failed)?,
                )
            }
            // Old clients must reload instead of receiving a false batch success.
            "batchId" | "fileIndex" | "totalFiles" | "jobId" => {
                return Err(AppError::BadRequest(localized_error!(
                    "backendErrors.upload.legacyBatch"
                )));
            }
            "emptyDirs" => {
                empty_dirs.push(validate_relative_path(
                    &field.text().await.map_err(request_failed)?,
                )?);
            }
            "file" => {
                let relative = validate_relative_path(field.file_name().unwrap_or("unnamed"))?;
                let destination = staging.join(relative);
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
        return Err(AppError::BadRequest(localized_error!(
            "backendErrors.upload.noFiles"
        )));
    }
    let mut local_paths = Vec::new();
    if file_count > 0 {
        let mut entries = tokio::fs::read_dir(staging)
            .await
            .map_err(upload_io_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(upload_io_error)? {
            local_paths.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok(UploadBatchParams {
        backend: None,
        remote,
        path,
        local_paths,
        origin,
        group,
        existing_jobid: None,
        no_cache: false,
        empty_dirs,
    })
}

fn upload_io_error(error: std::io::Error) -> AppError {
    AppError::Internal(if error.kind() == std::io::ErrorKind::StorageFull {
        localized_error!("backendErrors.file.diskFull")
    } else {
        localized_error!("backendErrors.request.failed", "error" => error.to_string())
    })
}

fn request_failed(error: impl std::fmt::Display) -> AppError {
    AppError::BadRequest(
        localized_error!("backendErrors.request.failed", "error" => error.to_string()),
    )
}

/// Accepts a path relative to the staging directory, returned with `/` separators.
/// `:` is only refused on Windows, where it names drives and alternate data
/// streams; elsewhere it is an ordinary filename character.
fn validate_relative_path(path: &str) -> Result<String, AppError> {
    let normalized = path.replace('\\', "/");
    if normalized.split('/').any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\0')
            || (cfg!(windows) && part.contains(':'))
    }) {
        return Err(AppError::BadRequest(localized_error!(
            "backendErrors.upload.invalidPath"
        )));
    }
    Ok(normalized)
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
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk.map_err(request_failed)?)
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
        .ok_or_else(|| {
            AppError::BadRequest(localized_error!("backendErrors.upload.invalidModifiedTime"))
        })?;
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
    fn validates_relative_paths_by_component() {
        for name in [
            "../escape",
            "/absolute",
            "folder/../escape",
            "folder/./file",
            "",
            "a\0b",
            "folder//file",
        ] {
            assert!(validate_relative_path(name).is_err(), "{name:?}");
        }
        for name in ["report..txt", "folder/özel file.txt", ".hidden"] {
            assert_eq!(validate_relative_path(name).unwrap(), name);
        }
        assert_eq!(
            validate_relative_path("folder\\file.txt").unwrap(),
            "folder/file.txt"
        );
    }

    #[test]
    fn colons_are_only_refused_where_the_platform_gives_them_meaning() {
        for name in ["12:30 notes.txt", "C:\\escape", "folder/a:b"] {
            assert_eq!(
                validate_relative_path(name).is_err(),
                cfg!(windows),
                "{name}"
            );
        }
    }

    async fn raw_multipart(body: String) -> Multipart {
        use axum::{body::Body, extract::FromRequest, http::Request};
        let request = Request::builder()
            .header(
                "content-type",
                "multipart/form-data; boundary=test-boundary",
            )
            .body(Body::from(body))
            .unwrap();
        Multipart::from_request(request, &()).await.unwrap()
    }

    async fn multipart(fields: &[(&str, Option<&str>, &str)]) -> Multipart {
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
        raw_multipart(body).await
    }

    fn is_empty(directory: &Path) -> bool {
        std::fs::read_dir(directory).unwrap().next().is_none()
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
        let root = tempfile::tempdir().unwrap();
        let (staging, params) = stage_upload(input, root.path()).await.unwrap();
        assert!(staging.path().starts_with(root.path()));
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
        assert!(root.path().is_dir());
    }

    #[tokio::test]
    async fn rejects_duplicate_paths_and_batches_without_files() {
        let duplicate = multipart(&[
            ("file", Some("same.txt"), "one"),
            ("file", Some("same.txt"), "two"),
        ])
        .await;
        let root = tempfile::tempdir().unwrap();
        assert!(stage_upload(duplicate, root.path()).await.is_err());
        for rejected in [
            multipart(&[("remote", None, "drive:")]).await,
            multipart(&[("batchId", None, "../escape")]).await,
        ] {
            assert!(stage_upload(rejected, root.path()).await.is_err());
        }
    }

    #[tokio::test]
    async fn supports_pre_epoch_modification_time_and_rejects_traversal() {
        let input = multipart(&[("mtime", None, "-1000"), ("file", Some("old.txt"), "old")]).await;
        let root = tempfile::tempdir().unwrap();
        let (staging, _) = stage_upload(input, root.path()).await.unwrap();
        assert_eq!(
            std::fs::metadata(staging.path().join("old.txt"))
                .unwrap()
                .modified()
                .unwrap(),
            std::time::UNIX_EPOCH - std::time::Duration::from_secs(1)
        );
        let traversal = multipart(&[("file", Some("../escape"), "bad")]).await;
        assert!(stage_upload(traversal, root.path()).await.is_err());
    }

    #[tokio::test]
    async fn empty_directories_are_validated_like_filenames() {
        let root = tempfile::tempdir().unwrap();
        let input = multipart(&[("emptyDirs", None, "a/b"), ("emptyDirs", None, "c\\d")]).await;
        let (_staging, params) = stage_upload(input, root.path()).await.unwrap();
        assert_eq!(params.empty_dirs, ["a/b", "c/d"]);
        assert!(params.local_paths.is_empty());
        for escape in ["../outside", "/absolute", "a//b", ""] {
            let input = multipart(&[("emptyDirs", None, escape)]).await;
            assert!(
                stage_upload(input, root.path()).await.is_err(),
                "{escape:?}"
            );
        }
    }

    #[tokio::test]
    async fn filenames_with_colons_stage_where_the_platform_allows_them() {
        let root = tempfile::tempdir().unwrap();
        let input = multipart(&[("file", Some("12:30 notes.txt"), "x")]).await;
        let staged = stage_upload(input, root.path()).await;
        assert_eq!(staged.is_ok(), !cfg!(windows));
    }

    #[tokio::test]
    async fn stale_staging_is_cleared_and_a_missing_root_is_fine() {
        let app = AppHandle::default();
        let temp = tempfile::tempdir().unwrap();
        app.manage(crate::services::paths::AppPaths {
            config_dir: temp.path().join("config"),
            cache_dir: temp.path().join("cache"),
            logs_dir: temp.path().join("logs"),
            resource_dir: temp.path().join("resources"),
        });
        clear_stale_upload_staging(&app).await;
        let leftover = upload_staging_root(&app).join("rclone_upload_old");
        std::fs::create_dir_all(&leftover).unwrap();
        std::fs::write(leftover.join("file"), "x").unwrap();
        clear_stale_upload_staging(&app).await;
        assert!(!upload_staging_root(&app).exists());
        assert!(temp.path().join("cache").parent().unwrap().is_dir());
    }

    #[test]
    fn disk_full_errors_use_the_existing_translation_key() {
        let error = upload_io_error(std::io::Error::from(std::io::ErrorKind::StorageFull));
        let AppError::Internal(message) = error else {
            panic!("expected IO error")
        };
        assert!(message.contains("backendErrors.file.diskFull"));
    }
    #[tokio::test]
    async fn stages_multiple_distinct_files() {
        let input = multipart(&[
            ("file", Some("first.txt"), "one"),
            ("file", Some("second.txt"), "two"),
        ])
        .await;
        let root = tempfile::tempdir().unwrap();
        let (staging, params) = stage_upload(input, root.path()).await.unwrap();
        assert_eq!(params.local_paths.len(), 2);
        assert_eq!(
            std::fs::read_to_string(staging.path().join("first.txt")).unwrap(),
            "one"
        );
        assert_eq!(
            std::fs::read_to_string(staging.path().join("second.txt")).unwrap(),
            "two"
        );
    }

    #[tokio::test]
    async fn invalid_requests_remove_already_staged_files() {
        let root = tempfile::tempdir().unwrap();
        let input = multipart(&[
            ("file", Some("first.txt"), "data"),
            ("file", Some("../escape.txt"), "data"),
        ])
        .await;
        assert!(stage_upload(input, root.path()).await.is_err());
        assert!(is_empty(root.path()));
    }

    #[tokio::test]
    async fn a_request_cut_off_mid_file_leaves_no_partial_file_behind() {
        let root = tempfile::tempdir().unwrap();
        // The client vanished after the first file and part of the second.
        let input = raw_multipart(
            "--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"done.bin\"\r\n\r\nall of it\r\n\
             --test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"big.bin\"\r\n\r\nonly the first part"
                .into(),
        )
        .await;
        assert!(stage_upload(input, root.path()).await.is_err());
        assert!(
            is_empty(root.path()),
            "complete and partial files are both removed"
        );
    }

    #[tokio::test]
    async fn staged_files_are_removed_whether_the_transfer_succeeds_or_fails() {
        let root = tempfile::tempdir().unwrap();
        for outcome in [Ok("job"), Err("transfer failed")] {
            let input = multipart(&[("file", Some("a.txt"), "data")]).await;
            let (staging, _) = stage_upload(input, root.path()).await.unwrap();
            let staged = staging.path().join("a.txt");
            let result = run_then_discard(staging, async {
                assert!(staged.exists(), "files exist while the transfer runs");
                outcome
            })
            .await;
            assert_eq!(result, outcome);
            assert!(!staged.exists());
            assert!(is_empty(root.path()));
        }
    }
}
