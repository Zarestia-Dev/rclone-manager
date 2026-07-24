use log::debug;
use tauri::{AppHandle, Emitter, Window, command};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[command]
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
            return Err(crate::localized_error!("backendErrors.file.driveRoot"));
        }
    }

    if require_empty {
        debug!("Checking if folder is empty: {folder}");
        let path = std::path::Path::new(&folder);

        // Check if folder exists and is empty
        match tokio::fs::read_dir(path).await {
            Ok(mut entries) => match entries.next_entry().await {
                Ok(Some(_)) => {
                    return Err(crate::localized_error!("backendErrors.file.folderNotEmpty"));
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
                error!("Failed to remove folder: {}", e);
                return Err(format!("Failed to prepare folder: {}", e));
            }
        }
    }

    Ok(Some(folder))
}

#[command]
pub async fn open_in_files(
    app: tauri::AppHandle,
    path: std::path::PathBuf,
) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err(crate::localized_error!("backendErrors.file.invalidPath"));
    }

    if !path.exists() {
        return Err(crate::localized_error!(
            "backendErrors.file.notFound",
            "path" => path.display().to_string()
        ));
    }

    let path_str = path
        .to_str()
        .ok_or_else(|| format!("Invalid path: {}", path.display()))?
        .to_string();
    match app.opener().open_path(path_str, None::<String>) {
        Ok(()) => Ok(format!("Opened file manager at {}", path.display())),
        Err(e) => Err(crate::localized_error!(
            "backendErrors.file.failedToOpen",
            "error" => e.to_string()
        )),
    }
}

#[command]
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
            return Err(crate::localized_error!(
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
            app.opener()
                .open_path(&path_str, None::<String>)
                .map_err(|e| crate::localized_error!("backendErrors.file.failedToOpen", "error" => e.to_string()))?;
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

    let dest_path = cache_dir.join(clean_file_name);
    let dest_str = dest_path
        .to_str()
        .ok_or_else(|| format!("Invalid target path: {}", dest_path.display()))?
        .to_string();

    let transport = crate::rclone::commands::common::transport(&app);

    let mut reader = transport
        .read_file(&remote, &path, None)
        .await
        .map_err(|e| format!("Failed to read remote file: {e}"))?;

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

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        app.opener()
            .open_path(&dest_str, None::<String>)
            .map_err(|e| crate::localized_error!("backendErrors.file.failedToOpen", "error" => e.to_string()))?;
    }

    Ok(dest_str)
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

#[command]
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

#[command]
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

#[command]
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

#[command]
pub async fn download_file(
    app: AppHandle,
    remote: String,
    path: String,
    destination: String,
    total_size: Option<u64>,
    is_local: bool,
) -> Result<(), String> {
    let transport = crate::rclone::commands::common::transport(&app);

    // Resolve target path and remote for rclone
    let (remote_arg, path_arg) = if is_local {
        let mut full_path = std::path::PathBuf::from(remote);
        full_path.push(path);
        ("".to_string(), full_path.to_string_lossy().into_owned())
    } else {
        (remote, path)
    };

    let mut reader = transport
        .read_file(&remote_arg, &path_arg, None)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let mut file = tokio::fs::File::create(&destination)
        .await
        .map_err(|e| format!("Failed to create destination file: {e}"))?;

    let mut buffer = vec![0; 65536]; // 64KB chunk
    let mut downloaded_bytes: u64 = 0;

    #[derive(serde::Serialize, Clone)]
    struct DownloadProgressPayload {
        destination: String,
        downloaded: u64,
        total: Option<u64>,
        done: bool,
    }

    loop {
        let n = reader
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Error reading source file: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])
            .await
            .map_err(|e| format!("Error writing destination file: {e}"))?;
        downloaded_bytes += n as u64;

        let _ = app.emit(
            "download-file-progress",
            DownloadProgressPayload {
                destination: destination.clone(),
                downloaded: downloaded_bytes,
                total: total_size,
                done: false,
            },
        );
    }

    file.flush()
        .await
        .map_err(|e| format!("Error flushing destination file: {e}"))?;

    let _ = app.emit(
        "download-file-progress",
        DownloadProgressPayload {
            destination: destination.clone(),
            downloaded: downloaded_bytes,
            total: total_size,
            done: true,
        },
    );

    Ok(())
}
