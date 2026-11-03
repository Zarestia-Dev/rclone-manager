//! Native file commands: dialogs, the system file manager, previews and downloads.
use crate::context::BackendContext;
use crate::services::paths::AppPaths;
use crate::services::settings::access;
use crate::utils::io::file_stream::open_asset;
use crate::utils::io::staged_file::{CopyError, StagedFile, copy_in_chunks};
use crate::utils::types::events::{FILE_DOWNLOAD_PROGRESS, FileDownloadProgressPayload};
use log::debug;
use std::fmt::Display;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

/// Preview files of remote documents, below the cache directory.
const TEMP_VIEWS_DIR: &str = "temp_views";

/// Falls back to this when a preview has no usable file name.
const DEFAULT_PREVIEW_NAME: &str = "document.pdf";

fn io_error(error: impl Display) -> String {
    rclone_manager_core::localized_error!("backendErrors.file.ioError", "error" => error)
}

fn open_failed(error: impl Display) -> String {
    rclone_manager_core::localized_error!("backendErrors.file.failedToOpen", "error" => error)
}

fn copy_error(error: CopyError) -> String {
    match error {
        CopyError::Io(error) => io_error(error),
        CopyError::Aborted(message) => message,
    }
}

/// Runs a file operation for the vault session that was open when it started: if the
/// vault locks or changes meanwhile, nothing is returned to the caller.
async fn with_file_access<T>(
    app: &AppHandle,
    revision: Option<u64>,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    access::require_session(app.backend(), revision)?;
    let result = operation.await;
    access::require_session(app.backend(), revision)?;
    result
}

/// Native dialogs block their thread until the user answers.
async fn blocking_dialog<T: Send + 'static>(
    dialog: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    crate::utils::spawn_blocking(dialog)
        .await
        .map_err(open_failed)
}

// Dialogs

#[tauri::command]
#[cfg(desktop)]
pub async fn get_folder_location(
    app: AppHandle,
    require_empty: bool,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let revision = access::revision(app.backend());
    with_file_access(
        &app,
        revision,
        pick_folder(&app, revision, require_empty, initial_path),
    )
    .await
}

#[cfg(desktop)]
async fn pick_folder(
    app: &AppHandle,
    revision: Option<u64>,
    require_empty: bool,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(path) = initial_path {
        dialog = dialog.set_directory(path);
    }
    let selected = blocking_dialog(move || {
        dialog
            .set_title("Select Folder")
            .blocking_pick_folder()
            .map(|path| path.to_string())
    })
    .await?;
    // The dialog can stay open for minutes; the checks below touch the filesystem.
    access::require_session(app.backend(), revision)?;

    let Some(folder) = selected.filter(|path| !path.is_empty()) else {
        debug!("User cancelled folder selection");
        return Ok(None);
    };

    #[cfg(target_os = "windows")]
    reject_drive_root(&folder)?;

    if require_empty {
        ensure_empty_folder(&folder).await?;
    }
    Ok(Some(folder))
}

/// A whole drive (`D:\`) cannot be a mount point.
#[cfg(target_os = "windows")]
fn reject_drive_root(folder: &str) -> Result<(), String> {
    use std::path::Component;
    let path = Path::new(folder);
    if matches!(path.components().next(), Some(Component::Prefix(_))) && path.parent().is_none() {
        debug!("Selected path is a drive root, which is not allowed for mounting");
        return Err(rclone_manager_core::localized_error!(
            "backendErrors.file.driveRoot"
        ));
    }
    Ok(())
}

/// A missing folder passes (rclone creates it). On Windows an empty one is removed,
/// because WinFsp needs the mount directory not to exist.
#[cfg(desktop)]
async fn ensure_empty_folder(folder: &str) -> Result<(), String> {
    debug!("Checking if folder is empty: {folder}");
    let path = Path::new(folder);
    match tokio::fs::read_dir(path).await {
        Ok(mut entries) => {
            if entries.next_entry().await.map_err(io_error)?.is_some() {
                return Err(rclone_manager_core::localized_error!(
                    "backendErrors.file.folderNotEmpty"
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_error(e)),
    }

    #[cfg(target_os = "windows")]
    remove_empty_mount_directory(path).await.map_err(io_error)?;
    Ok(())
}

// Never recurse: a file may appear after the dialog's emptiness check.
#[cfg(any(target_os = "windows", test))]
async fn remove_empty_mount_directory(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir(path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[tauri::command]
pub async fn get_file_location(window: Window) -> Result<Option<String>, String> {
    let app = window.app_handle().clone();
    let revision = access::revision(app.backend());
    with_file_access(&app, revision, async {
        let dialog = window.dialog().file();
        blocking_dialog(move || dialog.blocking_pick_file().map(|path| path.to_string())).await
    })
    .await
}

#[tauri::command]
pub async fn get_files_location(window: Window) -> Result<Option<Vec<String>>, String> {
    let app = window.app_handle().clone();
    let revision = access::revision(app.backend());
    with_file_access(&app, revision, async {
        let dialog = window.dialog().file();
        blocking_dialog(move || {
            dialog
                .blocking_pick_files()
                .map(|paths| paths.into_iter().map(|path| path.to_string()).collect())
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn get_save_file_location(
    app: AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let revision = access::revision(app.backend());
    with_file_access(&app, revision, async {
        let mut dialog = app.dialog().file();
        if let Some(name) = &default_name {
            dialog = dialog.set_file_name(name);
        }
        blocking_dialog(move || dialog.blocking_save_file().map(|path| path.to_string())).await
    })
    .await
}

// System file manager

#[tauri::command]
pub async fn open_in_files(app: AppHandle, path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err(rclone_manager_core::localized_error!(
            "backendErrors.file.invalidPath"
        ));
    }
    open_in_file_manager(&app, path)
}

#[cfg(target_os = "android")]
fn open_in_file_manager(_app: &AppHandle, path: &str) -> Result<(), String> {
    use crate::rclone::backend::saf_bridge;
    let opened = if let Some(saf_target) = path.strip_prefix("saf://") {
        let remote = saf_target.split('/').next().unwrap_or("").trim_matches(':');
        if remote.is_empty() {
            return Err(rclone_manager_core::localized_error!(
                "backendErrors.file.invalidPath"
            ));
        }
        saf_bridge::open_saf_remote(remote)
    } else {
        saf_bridge::open_local_path(path)
    };
    if opened {
        Ok(())
    } else {
        Err(open_failed("the system file manager rejected the path"))
    }
}

#[cfg(not(target_os = "android"))]
fn open_in_file_manager(app: &AppHandle, path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !Path::new(path).exists() {
        return Err(rclone_manager_core::localized_error!(
            "backendErrors.file.notFound",
            "path" => path
        ));
    }
    app.opener()
        .open_path(path, None::<String>)
        .map_err(open_failed)
}

/// Hands `path` to the operating system's default application for it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open_with_default_app(app: &AppHandle, path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<String>)
        .map_err(open_failed)
}

/// Android shares the file through the Kotlin bridge after this command returns.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn open_with_default_app(_app: &AppHandle, _path: &str) -> Result<(), String> {
    Ok(())
}

// Previews

/// Opens a file in its default application and returns the local path that was opened.
/// Remote files are first copied into a private preview directory.
#[tauri::command]
pub async fn open_file_natively(
    app: AppHandle,
    remote: String,
    path: String,
    file_name: String,
    is_local: bool,
) -> Result<String, String> {
    let revision = access::revision(app.backend());
    with_file_access(&app, revision, async {
        if is_local {
            open_local_file(&app, &remote, &path)
        } else {
            preview_remote_file(&app, revision, remote, path, &file_name).await
        }
    })
    .await
}

/// For local files the "remote" is the folder and the path is relative to it.
fn local_file_path(folder: &str, path: &str) -> PathBuf {
    PathBuf::from(folder).join(path)
}

fn open_local_file(app: &AppHandle, folder: &str, path: &str) -> Result<String, String> {
    let full_path = local_file_path(folder, path);
    if !full_path.exists() {
        return Err(rclone_manager_core::localized_error!(
            "backendErrors.file.notFound",
            "path" => full_path.display()
        ));
    }
    let full_path = full_path
        .to_str()
        .ok_or_else(|| rclone_manager_core::localized_error!("backendErrors.file.invalidPath"))?;
    open_with_default_app(app, full_path)?;
    Ok(full_path.to_string())
}

/// The last component of `file_name`, so a preview can never leave its directory.
fn preview_file_name(file_name: &str) -> &str {
    Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DEFAULT_PREVIEW_NAME)
}

async fn preview_remote_file(
    app: &AppHandle,
    revision: Option<u64>,
    remote: String,
    path: String,
    file_name: &str,
) -> Result<String, String> {
    let cache_dir = temp_views_dir(app)?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(io_error)?;

    // Each preview keeps its original filename in an isolated directory: two remotes
    // (or concurrent opens) must not overwrite the same cached file.
    let preview_directory = create_preview_directory(cache_dir).await?;
    let destination = preview_directory.path().join(preview_file_name(file_name));
    let destination_str = destination
        .to_str()
        .ok_or_else(|| rclone_manager_core::localized_error!("backendErrors.file.invalidPath"))?;

    let transport = crate::rclone::commands::common::transport(app.backend());
    let source = open_asset(transport, &remote, &path)
        .await
        .map_err(io_error)?;
    let size = source.total();
    let mut reader = source.into_reader(0, size).await.map_err(io_error)?;

    let mut file = tokio::fs::File::create(&destination)
        .await
        .map_err(io_error)?;
    copy_in_chunks(&mut reader, &mut file, |_| {
        access::require_session(app.backend(), revision)
    })
    .await
    .map_err(copy_error)?;
    file.flush().await.map_err(io_error)?;
    access::require_session(app.backend(), revision)?;

    // The external application may still be reading it after this command returns.
    // Startup/shutdown cleanup owns successful preview directories.
    let _ = preview_directory.keep();

    open_with_default_app(app, destination_str)?;
    Ok(destination_str.to_string())
}

async fn create_preview_directory(cache_dir: PathBuf) -> Result<tempfile::TempDir, String> {
    crate::utils::spawn_blocking(move || {
        tempfile::Builder::new()
            .prefix("view-")
            .tempdir_in(cache_dir)
    })
    .await
    .map_err(io_error)?
    .map_err(io_error)
}

fn temp_views_dir(app: &AppHandle) -> Result<PathBuf, String> {
    AppPaths::from_app_handle(app.backend())
        .map(|paths| paths.cache_dir.join(TEMP_VIEWS_DIR))
        .map_err(io_error)
}

/// Removes all temporary preview files. Called during app startup and shutdown.
#[cfg(not(target_os = "android"))]
pub fn cleanup_temp_views(app: &AppHandle) {
    if let Ok(paths) = AppPaths::from_app_handle(app.backend()) {
        remove_temp_views(&paths.cache_dir);
    }
}

pub fn remove_temp_views(cache_dir: &Path) {
    let temp_views_dir = cache_dir.join(TEMP_VIEWS_DIR);
    if temp_views_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&temp_views_dir) {
            log::warn!("Failed to clean up temp_views directory: {e}");
        } else {
            debug!("Successfully cleaned up temp_views directory");
        }
    }
}

// Downloads

/// An empty file is complete as soon as it exists.
fn percentage(done: u64, total: u64) -> f64 {
    if total == 0 {
        100.0
    } else {
        done as f64 / total as f64 * 100.0
    }
}

/// Minimum time between progress events.
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    remote: String,
    path: String,
    destination: String,
    is_local: bool,
) -> Result<(), String> {
    let revision = access::revision(app.backend());
    with_file_access(
        &app,
        revision,
        save_to_destination(&app, revision, remote, path, destination, is_local),
    )
    .await
}

async fn save_to_destination(
    app: &AppHandle,
    revision: Option<u64>,
    remote: String,
    path: String,
    destination: String,
    is_local: bool,
) -> Result<(), String> {
    // Local files are addressed through rclone as a bare path.
    let (remote, path) = if is_local {
        (
            String::new(),
            local_file_path(&remote, &path)
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        (remote, path)
    };

    let transport = crate::rclone::commands::common::transport(app.backend());
    let source = open_asset(transport, &remote, &path)
        .await
        .map_err(io_error)?;
    let size = source.total();
    let mut reader = source.into_reader(0, size).await.map_err(io_error)?;

    let mut target = open_destination(&destination).await?;
    let progress = |downloaded: u64| {
        crate::services::bridge::emit(
            FILE_DOWNLOAD_PROGRESS,
            FileDownloadProgressPayload {
                destination: destination.clone(),
                downloaded,
                total: Some(size),
                percentage: Some(percentage(downloaded, size)),
            },
        );
    };

    let mut last_progress = std::time::Instant::now();
    let downloaded = copy_in_chunks(&mut reader, target.writer(), |downloaded| {
        access::require_session(app.backend(), revision)?;
        if downloaded < size && last_progress.elapsed() >= PROGRESS_INTERVAL {
            progress(downloaded);
            last_progress = std::time::Instant::now();
        }
        Ok(())
    })
    .await
    .map_err(copy_error)?;

    drop(reader);
    access::require_session(app.backend(), revision)?;
    target
        .commit(Path::new(&destination))
        .await
        .map_err(io_error)?;
    progress(downloaded);
    Ok(())
}

/// Content URIs on Android are written in place: storage providers offer no portable
/// atomic replacement. Everything else keeps the old file until the new one is complete.
async fn open_destination(destination: &str) -> Result<StagedFile, String> {
    #[cfg(target_os = "android")]
    if destination.starts_with("content://") {
        use std::os::fd::FromRawFd;
        let raw_fd = crate::rclone::backend::saf_bridge::open_content_uri_fd(destination, "wt")
            .map_err(io_error)?;
        // SAFETY: the bridge hands over ownership of a freshly opened descriptor.
        let file = unsafe { std::fs::File::from_raw_fd(raw_fd) };
        return Ok(StagedFile::in_place(tokio::fs::File::from_std(file)));
    }
    StagedFile::create(Path::new(destination))
        .await
        .map_err(io_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mount_folder_cleanup_preserves_files_added_after_the_empty_check() {
        let directory = tempfile::tempdir().unwrap();
        let mount = directory.path().join("mount");
        tokio::fs::create_dir(&mount).await.unwrap();
        let file = mount.join("new-file.txt");
        tokio::fs::write(&file, b"keep").await.unwrap();
        assert!(remove_empty_mount_directory(&mount).await.is_err());
        assert_eq!(tokio::fs::read(&file).await.unwrap(), b"keep");
        tokio::fs::remove_file(file).await.unwrap();
        remove_empty_mount_directory(&mount).await.unwrap();
        assert!(!mount.exists());
        remove_empty_mount_directory(&mount).await.unwrap();
    }

    #[tokio::test]
    async fn mount_folders_must_be_empty_or_missing() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        ensure_empty_folder(missing.to_str().unwrap())
            .await
            .unwrap();

        let full = directory.path().join("full");
        tokio::fs::create_dir(&full).await.unwrap();
        tokio::fs::write(full.join("file"), b"x").await.unwrap();
        let error = ensure_empty_folder(full.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(error.contains("backendErrors.file.folderNotEmpty"));
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

    #[test]
    fn progress_of_an_empty_file_is_complete() {
        assert_eq!(percentage(0, 0), 100.0);
        assert_eq!(percentage(50, 200), 25.0);
        assert_eq!(percentage(200, 200), 100.0);
    }

    #[test]
    fn preview_names_cannot_escape_their_directory() {
        assert_eq!(preview_file_name("report.pdf"), "report.pdf");
        assert_eq!(preview_file_name("../../etc/passwd"), "passwd");
        assert_eq!(preview_file_name("dir/sub/clip.mp4"), "clip.mp4");
        for unusable in ["", "..", "/"] {
            assert_eq!(preview_file_name(unusable), DEFAULT_PREVIEW_NAME);
        }
    }

    #[test]
    fn local_files_resolve_inside_their_folder_unless_the_path_is_absolute() {
        assert_eq!(
            local_file_path("/data", "a/b.txt"),
            Path::new("/data/a/b.txt")
        );
        assert_eq!(
            local_file_path("/data", "/etc/hosts"),
            Path::new("/etc/hosts")
        );
    }

    #[test]
    fn temp_views_are_removed_from_the_given_cache_directory_only() {
        let cache = tempfile::tempdir().unwrap();
        let views = cache.path().join(TEMP_VIEWS_DIR).join("view-1");
        std::fs::create_dir_all(&views).unwrap();
        std::fs::write(views.join("a.pdf"), b"x").unwrap();
        std::fs::write(cache.path().join("keep.txt"), b"x").unwrap();
        remove_temp_views(cache.path());
        assert!(!cache.path().join(TEMP_VIEWS_DIR).exists());
        assert!(cache.path().join("keep.txt").exists());
        remove_temp_views(cache.path());
    }
}
