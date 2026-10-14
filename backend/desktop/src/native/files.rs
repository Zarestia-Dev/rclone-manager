use crate::context::BackendContext;
use crate::utils::io::file_stream::{file_metadata, file_reader, pin_file_transport};
use crate::utils::types::events::{FILE_DOWNLOAD_PROGRESS, FileDownloadProgressPayload};
use log::debug;
use tauri::{AppHandle, Window};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tauri::command]
#[cfg(desktop)]
pub async fn get_folder_location(
    app: AppHandle,
    require_empty: bool,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(path) = initial_path {
        dialog = dialog.set_directory(path);
    }
    let folder = match dialog
        .set_title("Select Folder")
        .blocking_pick_folder()
        .map(|p| p.to_string())
    {
        Some(path) if path.is_empty() => {
            debug!("User selected empty path");
            return Ok(None);
        }
        Some(path) => path,
        _ => {
            debug!("User cancelled folder selection");
            return Ok(None);
        }
    };

    #[cfg(target_os = "windows")]
    {
        // If the selected path is a drive root (e.g., D:\), prevent selection and show error

        use std::path::{Component, Path};
        let path = Path::new(&folder);
        if let Some(drive) = path.components().next()
            && matches!(drive, Component::Prefix(_))
            && path.parent().is_none()
        {
            debug!("Selected path is a drive root, which is not allowed for mounting");
            return Err(rclone_manager_core::localized_error!(
                "backendErrors.file.driveRoot"
            ));
        }
    }

    if require_empty {
        debug!("Checking if folder is empty: {folder}");
        let path = std::path::Path::new(&folder);

        // Check if folder exists and is empty
        match tokio::fs::read_dir(path).await {
            Ok(mut entries) => match entries.next_entry().await {
                Ok(Some(_)) => {
                    return Err(rclone_manager_core::localized_error!(
                        "backendErrors.file.folderNotEmpty"
                    ));
                }
                Ok(_) => (), // Folder is empty
                Err(e) => {
                    log::error!("Error reading directory: {e}");
                    return Err(format!("Error checking folder: {e}"));
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (), // Folder doesn't exist
            Err(e) => {
                log::error!("Error accessing folder: {e}");
                return Err(format!("Error accessing folder: {e}"));
            }
        }

        // On Windows, clean up the empty folder if it exists
        #[cfg(target_os = "windows")]
        if path.exists() {
            debug!("Removing existing empty folder on Windows");
            if let Err(e) = tokio::fs::remove_dir_all(path).await {
                log::error!("Failed to remove folder: {}", e);
                return Err(format!("Failed to prepare folder: {}", e));
            }
        }
    }

    Ok(Some(folder))
}

#[tauri::command]
pub async fn open_in_files(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let clean_path = path.trim();
    if clean_path.is_empty() {
        return Err(rclone_manager_core::localized_error!(
            "backendErrors.file.invalidPath"
        ));
    }

    #[cfg(target_os = "android")]
    {
        let _ = app;
        if let Some(saf_target) = clean_path.strip_prefix("saf://") {
            let remote = saf_target.split('/').next().unwrap_or("").trim_matches(':');
            if remote.is_empty() {
                return Err(rclone_manager_core::localized_error!(
                    "backendErrors.file.invalidPath"
                ));
            }
            if crate::rclone::backend::saf_bridge::open_saf_remote(remote) {
                return Ok(format!("Opened SAF remote {} in system files", remote));
            } else {
                return Err(rclone_manager_core::localized_error!(
                    "backendErrors.file.failedToOpen",
                    "error" => "SAF opener failed"
                ));
            }
        }

        if crate::rclone::backend::saf_bridge::open_local_path(clean_path) {
            Ok(format!("Opened local path {} in file manager", clean_path))
        } else {
            Err(rclone_manager_core::localized_error!(
                "backendErrors.file.failedToOpen",
                "error" => "Failed to open local path in file manager"
            ))
        }
    }

    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_opener::OpenerExt;
        let p = std::path::Path::new(clean_path);
        if !p.exists() {
            return Err(rclone_manager_core::localized_error!(
                "backendErrors.file.notFound",
                "path" => clean_path.to_string()
            ));
        }

        match app.opener().open_path(clean_path, None::<String>) {
            Ok(()) => Ok(format!("Opened file manager at {}", clean_path)),
            Err(e) => Err(rclone_manager_core::localized_error!(
                "backendErrors.file.failedToOpen",
                "error" => e.to_string()
            )),
        }
    }
}

#[tauri::command]
pub async fn open_file_natively(
    app: AppHandle,
    remote: String,
    path: String,
    file_name: String,
    is_local: bool,
) -> Result<String, String> {
    use tauri::Manager;

    let clean_file_name = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf");

    if is_local {
        let mut full_path = std::path::PathBuf::from(&remote);
        full_path.push(&path);

        if !full_path.exists() {
            return Err(rclone_manager_core::localized_error!(
                "backendErrors.file.notFound",
                "path" => full_path.display().to_string()
            ));
        }

        let path_str = full_path
            .to_str()
            .ok_or_else(|| format!("Invalid path: {}", full_path.display()))?
            .to_string();

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_path(&path_str, None::<String>)
                .map_err(|e| rclone_manager_core::localized_error!("backendErrors.file.failedToOpen", "error" => e.to_string()))?;
        }

        return Ok(path_str);
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to get cache directory: {e}"))?
        .join("temp_views");

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Failed to create temp_views directory: {e}"))?;

    // Each preview keeps its own original filename in an isolated directory.
    // Two remotes (or concurrent opens) must not overwrite the same cached file.
    let temp_directory = create_preview_directory(cache_dir).await?;
    let dest_path = temp_directory.path().join(clean_file_name);
    let dest_str = dest_path
        .to_str()
        .ok_or_else(|| format!("Invalid target path: {}", dest_path.display()))?
        .to_string();

    let transport = crate::rclone::commands::common::transport(app.backend());

    let transport = pin_file_transport(transport)
        .await
        .map_err(|e| format!("Failed to select file backend: {e}"))?;
    let version = file_metadata(transport.as_ref(), &remote, &path)
        .await
        .map_err(|e| format!("Failed to read remote file metadata: {e}"))?;
    let size = version.size;
    let mut reader = file_reader(transport, remote, path, 0, size, Some(version));

    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|e| format!("Failed to create temporary file: {e}"))?;

    let mut buffer = vec![0; 65536];
    loop {
        let n = reader
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Error reading remote file stream: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])
            .await
            .map_err(|e| format!("Error writing temporary file: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Error flushing temporary file: {e}"))?;
    // The external application may still be reading it after this command returns.
    // Startup/shutdown cleanup owns successful preview directories.
    let _ = temp_directory.keep();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(&dest_str, None::<String>)
            .map_err(|e| rclone_manager_core::localized_error!("backendErrors.file.failedToOpen", "error" => e.to_string()))?;
    }

    Ok(dest_str)
}

async fn create_preview_directory(
    cache_dir: std::path::PathBuf,
) -> Result<tempfile::TempDir, String> {
    crate::utils::spawn_blocking(move || {
        tempfile::Builder::new()
            .prefix("view-")
            .tempdir_in(cache_dir)
    })
    .await
    .map_err(|e| format!("Failed to create preview directory: {e}"))?
    .map_err(|e| format!("Failed to create preview directory: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unfinished_download_preserves_existing_destination_and_cleans_up() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("song.mp3");
        tokio::fs::write(&destination, b"original").await.unwrap();
        let (mut file, temporary) = stage_download(destination.to_str().unwrap()).await.unwrap();
        let temporary_path = temporary.path().to_owned();
        file.write_all(b"partial").await.unwrap();
        drop(file);
        drop(temporary);
        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"original");
        assert!(!temporary_path.exists());
    }

    #[tokio::test]
    async fn downloading_a_file_to_itself_preserves_its_contents() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("song.mp3");
        tokio::fs::write(&destination, b"complete source")
            .await
            .unwrap();
        let (mut file, temporary) = stage_download(destination.to_str().unwrap()).await.unwrap();
        let mut source = tokio::fs::File::open(&destination).await.unwrap();
        tokio::io::copy(&mut source, &mut file).await.unwrap();
        file.flush().await.unwrap();
        drop(source);
        drop(file);
        commit_download(temporary, destination.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(destination).await.unwrap(),
            b"complete source"
        );
    }

    #[tokio::test]
    async fn concurrent_previews_with_the_same_name_do_not_share_a_file() {
        let cache = tempfile::tempdir().unwrap();
        let (first, second) = tokio::join!(
            create_preview_directory(cache.path().into()),
            create_preview_directory(cache.path().into()),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        let first_file = first.path().join("song.mp3");
        let second_file = second.path().join("song.mp3");
        tokio::fs::write(&first_file, b"remote A").await.unwrap();
        tokio::fs::write(&second_file, b"remote B").await.unwrap();
        assert_ne!(first_file, second_file);
        assert_eq!(tokio::fs::read(first_file).await.unwrap(), b"remote A");
        assert_eq!(tokio::fs::read(second_file).await.unwrap(), b"remote B");
        let failed_directory = first.path().to_path_buf();
        drop(first);
        assert!(!failed_directory.exists());
    }
}

/// Removes all temporary preview/viewer files cached in `app_cache_dir()/temp_views`.
/// Called during app startup and shutdown.
pub fn cleanup_temp_views(app: &AppHandle) {
    use tauri::Manager;
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        let temp_views_dir = cache_dir.join("temp_views");
        if temp_views_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&temp_views_dir) {
                log::warn!("Failed to clean up temp_views directory: {e}");
            } else {
                debug!("Successfully cleaned up temp_views directory");
            }
        }
    }
}

#[tauri::command]
pub async fn get_file_location(window: Window) -> Result<Option<String>, String> {
    debug!("Opening file picker dialog...");

    let file_location = window
        .dialog()
        .file()
        .blocking_pick_file()
        .map(|path| path.to_string());

    debug!("File location: {file_location:?}");

    Ok(file_location)
}

#[tauri::command]
pub async fn get_files_location(window: Window) -> Result<Option<Vec<String>>, String> {
    debug!("Opening multi-file picker dialog...");

    let file_locations = window.dialog().file().blocking_pick_files().map(|paths| {
        paths
            .into_iter()
            .map(|path| path.to_string())
            .collect::<Vec<_>>()
    });

    debug!("File locations: {file_locations:?}");

    Ok(file_locations)
}

#[tauri::command]
pub async fn get_save_file_location(
    app: AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(ref name) = default_name {
        dialog = dialog.set_file_name(name);
    }
    let file_location = dialog.blocking_save_file().map(|path| path.to_string());
    Ok(file_location)
}

// Keep the existing destination intact until the complete source has been verified.
async fn stage_download(
    destination: &str,
) -> std::io::Result<(tokio::fs::File, tempfile::NamedTempFile)> {
    let parent = std::path::Path::new(destination)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    tokio::fs::create_dir_all(&parent).await?;
    let (file, temporary) = crate::utils::spawn_blocking(move || {
        let temporary = tempfile::Builder::new()
            .prefix(".rcman-download-")
            .tempfile_in(parent)?;
        let file = temporary.as_file().try_clone()?;
        Ok::<_, std::io::Error>((file, temporary))
    })
    .await
    .map_err(std::io::Error::other)??;
    Ok((tokio::fs::File::from_std(file), temporary))
}

async fn commit_download(
    temporary: tempfile::NamedTempFile,
    destination: String,
) -> std::io::Result<()> {
    crate::utils::spawn_blocking(move || {
        temporary
            .persist(destination)
            .map(|_| ())
            .map_err(|e| e.error)
    })
    .await
    .map_err(std::io::Error::other)?
}

fn download_error(error: impl std::fmt::Display) -> String {
    rclone_manager_core::localized_error!("backendErrors.file.ioError", "error" => error.to_string())
}

#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    remote: String,
    path: String,
    destination: String,
    total_size: Option<u64>,
    is_local: bool,
) -> Result<(), String> {
    let transport = crate::rclone::commands::common::transport(app.backend());

    // Resolve target path and remote for rclone
    let (remote_arg, path_arg) = if is_local {
        let mut full_path = std::path::PathBuf::from(remote);
        full_path.push(path);
        ("".to_string(), full_path.to_string_lossy().into_owned())
    } else {
        (remote, path)
    };

    let transport = pin_file_transport(transport)
        .await
        .map_err(download_error)?;
    let version = file_metadata(transport.as_ref(), &remote_arg, &path_arg)
        .await
        .map_err(download_error)?;
    let size = version.size;
    let mut reader = file_reader(transport, remote_arg, path_arg, 0, size, Some(version));

    #[cfg(target_os = "android")]
    let (mut file, temporary) = if destination.starts_with("content://") {
        // SAF providers do not offer a portable atomic replacement operation.
        use std::os::fd::FromRawFd;
        let raw_fd = crate::rclone::backend::saf_bridge::open_content_uri_fd(&destination, "wt")
            .map_err(download_error)?;
        let std_file = unsafe { std::fs::File::from_raw_fd(raw_fd) };
        (tokio::fs::File::from_std(std_file), None)
    } else {
        let (file, temporary) = stage_download(&destination).await.map_err(download_error)?;
        (file, Some(temporary))
    };

    #[cfg(not(target_os = "android"))]
    let (mut file, temporary) = {
        let (file, temporary) = stage_download(&destination).await.map_err(download_error)?;
        (file, Some(temporary))
    };

    let mut buffer = vec![0; 65536]; // 64KB chunk
    let mut downloaded_bytes: u64 = 0;

    if total_size.is_some_and(|hint| hint != size) {
        debug!("Download size hint differs from source metadata; using {size} bytes");
    }
    let mut last_progress = std::time::Instant::now();

    loop {
        let n = reader.read(&mut buffer).await.map_err(download_error)?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n]).await.map_err(download_error)?;
        downloaded_bytes += n as u64;

        if downloaded_bytes < size
            && last_progress.elapsed() >= std::time::Duration::from_millis(100)
        {
            crate::services::bridge::emit(
                FILE_DOWNLOAD_PROGRESS,
                FileDownloadProgressPayload {
                    destination: destination.clone(),
                    downloaded: downloaded_bytes,
                    total: Some(size),
                    percentage: Some(downloaded_bytes as f64 / size as f64 * 100.0),
                },
            );
            last_progress = std::time::Instant::now();
        }
    }

    drop(reader);
    file.flush().await.map_err(download_error)?;

    if let Some(temporary) = temporary {
        file.sync_all().await.map_err(download_error)?;
        drop(file);
        commit_download(temporary, destination.clone())
            .await
            .map_err(download_error)?;
    }

    crate::services::bridge::emit(
        FILE_DOWNLOAD_PROGRESS,
        FileDownloadProgressPayload {
            destination: destination.clone(),
            downloaded: downloaded_bytes,
            total: Some(size),
            percentage: Some(100.0),
        },
    );

    Ok(())
}
