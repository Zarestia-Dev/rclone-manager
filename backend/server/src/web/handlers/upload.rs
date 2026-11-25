//! Uploads from the browser arrive in chunks. The page opens a session that lists
//! its files, sends each file in pieces, then finishes the session, and the staged
//! files are transferred like any upload of local paths.
//!
//! Small requests pass proxies that limit a request's body (nginx allows 1 MB by
//! default), and a dropped connection costs one chunk instead of the whole upload.

use std::{
    collections::HashMap,
    future::Future,
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::{Body, Bytes},
    extract::{Path as UrlPath, Query, State},
    response::Json,
};
use futures::{Stream, StreamExt};
use rclone_manager_core::{context::AppHandle, localized_error};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::rclone::commands::upload::{UploadBatchParams, execute_upload_batch};
use crate::utils::types::origin::Origin;
use crate::web::state::{ApiResponse, AppError, WebServerState};

/// The largest part of an upload's file list, which is read whole to parse it.
/// Chunks of files have no limit of their own: they are written as they arrive and
/// stop at the end of their file. The page sizes both from its settings and halves
/// them while a proxy refuses them as too large.
pub const MAX_LIST_BYTES: usize = 8 * 1024 * 1024;
/// A session no request touched for this long was abandoned (its tab was closed).
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// How long finishing waits for the transfer: a short upload reports its outcome,
/// and the answer still comes well before a proxy gives up on it (Cloudflare: 100 s).
/// A longer transfer goes on as a job that the page follows.
const FINISH_WAIT: Duration = Duration::from_secs(20);

/// Uploads are staged in the application's cache, not the system temp directory,
/// which is often a small tmpfs.
fn upload_staging_root(app: &AppHandle) -> PathBuf {
    app.state::<crate::services::paths::AppPaths>()
        .cache_dir
        .join("uploads")
}

/// Staging directories are removed when their session ends, so whatever remains
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUpload {
    remote: String,
    path: String,
    origin: Option<Origin>,
    group: Option<String>,
    /// The options to transfer with, as the transfer dialog sets them: absent for the
    /// file browser's default.
    options: Option<serde_json::Value>,
    #[serde(flatten)]
    entries: UploadEntries,
}

/// Files and folders of an upload. A long list arrives in several requests, each
/// small enough for a proxy: the first opens the session, the others add to it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadEntries {
    #[serde(default)]
    files: Vec<NewUploadFile>,
    /// Folders without files, which no file path would create.
    #[serde(default)]
    empty_dirs: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewUploadFile {
    /// Relative to the destination, with `/` between folders.
    path: String,
    size: u64,
    /// Milliseconds since the Unix epoch.
    mtime: Option<i64>,
}

struct StagedFile {
    path: PathBuf,
    /// The page's path and modification time, by which a reloaded page finds the
    /// file again when the user selects it once more.
    relative: String,
    mtime: Option<i64>,
    size: u64,
    modified: Option<SystemTime>,
    received: AtomicU64,
    /// Chunks of one file are written one at a time, in order.
    writing: tokio::sync::Mutex<()>,
}

pub struct UploadSession {
    staging: Mutex<Option<tempfile::TempDir>>,
    /// The staging directory, also while `staging` is being taken.
    root: PathBuf,
    files: Mutex<Vec<Arc<StagedFile>>>,
    /// Lists are added one at a time, so their files keep the page's indices.
    adding: tokio::sync::Mutex<()>,
    transfer: UploadBatchParams,
    last_used: Mutex<Instant>,
}

impl UploadSession {
    fn touch(&self) {
        *self
            .last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed()
    }

    fn files(&self) -> std::sync::MutexGuard<'_, Vec<Arc<StagedFile>>> {
        self.files.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Bytes still to arrive, which the disk must keep room for.
    fn remaining(&self) -> u64 {
        self.files()
            .iter()
            .map(|file| file.size - file.received.load(Ordering::Acquire))
            .sum()
    }

    /// Adds the files and folders of a later list. `start` is the index the page gave
    /// its first file: a list sent again because its answer was lost changes nothing,
    /// and one that does not follow the files the session has is refused.
    async fn add_entries(
        &self,
        start: usize,
        entries: &UploadEntries,
        available: Option<u64>,
    ) -> Result<(), AppError> {
        let _adding = self.adding.lock().await;
        let count = self.files().len();
        if start != count {
            return if start + entries.files.len() <= count {
                Ok(())
            } else {
                Err(invalid_chunk())
            };
        }
        check_space(entries, available)?;
        let staged = stage_entries(entries, &self.root).await?;
        self.files().extend(staged.into_iter().map(Arc::new));
        Ok(())
    }

    fn is_complete(&self) -> bool {
        self.remaining() == 0
    }

    /// Writes a chunk at `offset` of file `index` as it arrives, so memory holds only
    /// the piece being written whatever the chunk's size, and returns how much of the
    /// file has arrived. A chunk that does not start there (sent again because its
    /// answer was lost) is not written: the answer tells the page where to continue.
    /// When the connection drops midway, the part that arrived is kept.
    async fn write_chunk<E: std::fmt::Display>(
        &self,
        index: usize,
        offset: u64,
        mut data: impl Stream<Item = Result<Bytes, E>> + Unpin,
    ) -> Result<u64, AppError> {
        let file = self.files().get(index).cloned().ok_or_else(invalid_chunk)?;
        let _writing = file.writing.lock().await;
        let received = file.received.load(Ordering::Acquire);
        if offset != received {
            return Ok(received);
        }
        let mut handle = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&file.path)
            .await
            .map_err(upload_io_error)?;
        // A write that failed halfway left bytes after `received`; they are overwritten.
        handle
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(upload_io_error)?;
        let mut end = offset;
        let mut failure = None;
        while let Some(piece) = data.next().await {
            let written = match piece {
                Err(error) => Err(AppError::BadRequest(
                    localized_error!("backendErrors.request.failed", "error" => error.to_string()),
                )),
                Ok(piece) => match end
                    .checked_add(piece.len() as u64)
                    .filter(|next| *next <= file.size)
                {
                    None => Err(invalid_chunk()),
                    Some(next) => handle
                        .write_all(&piece)
                        .await
                        .map(|()| next)
                        .map_err(upload_io_error),
                },
            };
            match written {
                Ok(next) => {
                    end = next;
                    self.touch();
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        // Writes are only certain once flushed; without that, nothing of this chunk counts.
        if let Err(error) = handle.flush().await {
            return Err(failure.unwrap_or_else(|| upload_io_error(error)));
        }
        file.received.store(end, Ordering::Release);
        if let Some(error) = failure {
            return Err(error);
        }
        if end == file.size {
            set_modified(handle, file.modified).await?;
        }
        Ok(end)
    }

    async fn discard(&self) {
        let staging = self
            .staging
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(staging) = staging {
            discard_staging(staging).await;
        }
    }
}

#[derive(Default)]
pub struct UploadSessions(Mutex<HashMap<String, Arc<UploadSession>>>);

impl UploadSessions {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<UploadSession>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn insert(&self, session: UploadSession) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions().insert(id.clone(), Arc::new(session));
        id
    }

    fn get(&self, id: &str) -> Option<Arc<UploadSession>> {
        self.sessions().get(id).cloned()
    }

    fn remove(&self, id: &str) -> Option<Arc<UploadSession>> {
        self.sessions().remove(id)
    }

    fn remaining(&self) -> u64 {
        self.sessions()
            .values()
            .map(|session| session.remaining())
            .sum()
    }
}

/// Removes the session and its files once no request has touched it for `timeout`.
fn expire_when_idle(sessions: Arc<UploadSessions>, id: String, timeout: Duration) {
    crate::utils::spawn(async move {
        let mut wait = timeout;
        loop {
            tokio::time::sleep(wait).await;
            let Some(session) = sessions.get(&id) else {
                return;
            };
            let idle = session.idle_for();
            if idle < timeout {
                wait = timeout - idle;
                continue;
            }
            if let Some(session) = sessions.remove(&id) {
                log::info!("Removing abandoned upload {id}");
                session.discard().await;
            }
            return;
        }
    });
}

/// Free space for new files in the staging root: sessions still receiving files
/// hold on to the room they will need.
async fn space_for_new_files(state: &WebServerState, root: &Path) -> Result<Option<u64>, AppError> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(upload_io_error)?;
    let disk_root = root.to_owned();
    let free = crate::utils::spawn_blocking(move || available_space(&disk_root))
        .await
        .map_err(AppError::internal)?;
    Ok(free.map(|free| free.saturating_sub(state.uploads.remaining())))
}

pub async fn create_upload_session(
    State(state): State<WebServerState>,
    Json(request): Json<NewUpload>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let root = upload_staging_root(&state.app_handle);
    let available = space_for_new_files(&state, &root).await?;
    let session = stage_session(&root, request, available).await?;
    let id = state.uploads.insert(session);
    expire_when_idle(state.uploads.clone(), id.clone(), IDLE_TIMEOUT);
    Ok(Json(ApiResponse::success(id)))
}

#[derive(Debug, Deserialize)]
pub struct ListPosition {
    start: usize,
}

pub async fn add_upload_entries(
    State(state): State<WebServerState>,
    UrlPath(id): UrlPath<String>,
    Query(position): Query<ListPosition>,
    Json(entries): Json<UploadEntries>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    let session = state.uploads.get(&id).ok_or_else(session_gone)?;
    session.touch();
    let available = space_for_new_files(&state, &upload_staging_root(&state.app_handle)).await?;
    session
        .add_entries(position.start, &entries, available)
        .await?;
    session.touch();
    Ok(Json(ApiResponse::success(())))
}

#[derive(Debug, Deserialize)]
pub struct ChunkPosition {
    offset: u64,
}

pub async fn upload_chunk(
    State(state): State<WebServerState>,
    UrlPath((id, index)): UrlPath<(String, usize)>,
    Query(position): Query<ChunkPosition>,
    data: Body,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    let session = state.uploads.get(&id).ok_or_else(session_gone)?;
    session.touch();
    let received = session
        .write_chunk(index, position.offset, data.into_data_stream())
        .await?;
    session.touch();
    Ok(Json(ApiResponse::success(received)))
}

/// A file of a session and how much of it has arrived.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileStatus {
    path: String,
    size: u64,
    mtime: Option<i64>,
    received: u64,
}

/// The session's files in the page's order, so a page reloaded during an upload
/// sends each one on from where it stopped.
pub async fn upload_session_status(
    State(state): State<WebServerState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<ApiResponse<Vec<UploadFileStatus>>>, AppError> {
    let session = state.uploads.get(&id).ok_or_else(session_gone)?;
    session.touch();
    let files = session
        .files()
        .iter()
        .map(|file| UploadFileStatus {
            path: file.relative.clone(),
            size: file.size,
            mtime: file.mtime,
            received: file.received.load(Ordering::Acquire),
        })
        .collect();
    Ok(Json(ApiResponse::success(files)))
}

/// Starts the transfer of a session whose files have all arrived. The answer is
/// `true` when the transfer finished within [`FINISH_WAIT`], `false` while it goes on.
pub async fn finish_upload_session(
    State(state): State<WebServerState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    let session = state.uploads.get(&id).ok_or_else(session_gone)?;
    if !session.is_complete() {
        return Err(AppError::BadRequest(localized_error!(
            "backendErrors.upload.incomplete"
        )));
    }
    // Removed first, so a repeated request cannot start the transfer twice.
    let session = state.uploads.remove(&id).ok_or_else(session_gone)?;
    let staging = session
        .staging
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .ok_or_else(session_gone)?;
    let local_paths = match top_level_entries(staging.path()).await {
        Ok(paths) => paths,
        Err(error) => {
            discard_staging(staging).await;
            return Err(error);
        }
    };
    let mut params = session.transfer.clone();
    params.local_paths = local_paths;
    params.backend = Some(
        state
            .app_handle
            .state::<crate::rclone::backend::BackendManager>()
            .get_active()
            .await,
    );
    // The task owns the staged files, so a page that leaves does not stop the transfer.
    let mut transfer = crate::utils::spawn(run_then_discard(
        staging,
        execute_upload_batch(state.app_handle.clone(), params),
    ));
    match tokio::time::timeout(FINISH_WAIT, &mut transfer).await {
        Ok(result) => {
            result
                .map_err(AppError::internal)?
                .map_err(AppError::internal)?;
            Ok(Json(ApiResponse::success(true)))
        }
        Err(_) => {
            crate::utils::spawn(async move {
                if let Ok(Err(error)) = transfer.await {
                    log::warn!("Upload {id} failed: {error}");
                }
            });
            Ok(Json(ApiResponse::success(false)))
        }
    }
}

pub async fn cancel_upload_session(
    State(state): State<WebServerState>,
    UrlPath(id): UrlPath<String>,
) -> Json<ApiResponse<()>> {
    if let Some(session) = state.uploads.remove(&id) {
        session.discard().await;
    }
    Json(ApiResponse::success(()))
}

/// Pages from before chunked uploads post the whole upload here; they must reload.
pub async fn legacy_upload_handler() -> AppError {
    AppError::BadRequest(localized_error!("backendErrors.upload.legacyBatch"))
}

/// Creates the session's folders and empty files in a new directory under `root`.
/// `available` is the free space left for it, when known: an upload that cannot fit
/// is refused before any of it is sent. When this fails, nothing remains.
async fn stage_session(
    root: &Path,
    request: NewUpload,
    available: Option<u64>,
) -> Result<UploadSession, AppError> {
    if request.entries.files.is_empty() && request.entries.empty_dirs.is_empty() {
        return Err(AppError::BadRequest(localized_error!(
            "backendErrors.upload.noFiles"
        )));
    }
    check_space(&request.entries, available)?;
    let staging = tempfile::Builder::new()
        .prefix("rclone_upload_")
        .tempdir_in(root)
        .map_err(upload_io_error)?;
    let files = match stage_entries(&request.entries, staging.path()).await {
        Ok(files) => files,
        Err(error) => {
            discard_staging(staging).await;
            return Err(error);
        }
    };
    Ok(UploadSession {
        root: staging.path().to_owned(),
        staging: Mutex::new(Some(staging)),
        files: Mutex::new(files.into_iter().map(Arc::new).collect()),
        adding: tokio::sync::Mutex::new(()),
        transfer: UploadBatchParams {
            backend: None,
            remote: request.remote,
            path: request.path,
            local_paths: Vec::new(),
            origin: request.origin,
            group: request.group,
            options: request.options,
        },
        last_used: Mutex::new(Instant::now()),
    })
}

/// An upload that cannot fit is refused before any of it is sent.
fn check_space(entries: &UploadEntries, available: Option<u64>) -> Result<(), AppError> {
    let needed = entries
        .files
        .iter()
        .fold(0u64, |sum, file| sum.saturating_add(file.size));
    if available.is_some_and(|free| needed > free) {
        return Err(upload_io_error(std::io::ErrorKind::StorageFull.into()));
    }
    Ok(())
}

async fn stage_entries(
    request: &UploadEntries,
    staging: &Path,
) -> Result<Vec<StagedFile>, AppError> {
    // Staged as real folders, so they travel with the files they sit beside.
    for dir in &request.empty_dirs {
        tokio::fs::create_dir_all(staging.join(validate_relative_path(dir)?))
            .await
            .map_err(upload_io_error)?;
    }
    let mut files = Vec::with_capacity(request.files.len());
    for file in &request.files {
        let relative = validate_relative_path(&file.path)?;
        let path = staging.join(&relative);
        let modified = file.mtime.map(modified_time).transpose()?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(upload_io_error)?;
        }
        // Reject duplicate paths instead of silently replacing an earlier file.
        let handle = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .map_err(upload_io_error)?;
        if file.size == 0 {
            set_modified(handle, modified).await?;
        }
        files.push(StagedFile {
            path,
            relative,
            mtime: file.mtime,
            size: file.size,
            modified,
            received: AtomicU64::new(0),
            writing: tokio::sync::Mutex::new(()),
        });
    }
    Ok(files)
}

async fn top_level_entries(staging: &Path) -> Result<Vec<String>, AppError> {
    let mut paths = Vec::new();
    let mut entries = tokio::fs::read_dir(staging)
        .await
        .map_err(upload_io_error)?;
    while let Some(entry) = entries.next_entry().await.map_err(upload_io_error)? {
        paths.push(entry.path().to_string_lossy().into_owned());
    }
    Ok(paths)
}

/// Free space on the disk that holds `path`, when the system reports that disk.
fn available_space(path: &Path) -> Option<u64> {
    let path = std::fs::canonicalize(path).ok()?;
    sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(sysinfo::Disk::available_space)
}

fn modified_time(mtime: i64) -> Result<SystemTime, AppError> {
    let duration = Duration::from_millis(mtime.unsigned_abs());
    if mtime < 0 {
        SystemTime::UNIX_EPOCH.checked_sub(duration)
    } else {
        SystemTime::UNIX_EPOCH.checked_add(duration)
    }
    .ok_or_else(|| {
        AppError::BadRequest(localized_error!("backendErrors.upload.invalidModifiedTime"))
    })
}

async fn set_modified(
    handle: tokio::fs::File,
    modified: Option<SystemTime>,
) -> Result<(), AppError> {
    if let Some(modified) = modified {
        handle
            .into_std()
            .await
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .map_err(upload_io_error)?;
    }
    Ok(())
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

fn session_gone() -> AppError {
    AppError::NotFound(localized_error!("backendErrors.upload.sessionGone"))
}

fn invalid_chunk() -> AppError {
    AppError::BadRequest(localized_error!("backendErrors.upload.invalidChunk"))
}

fn upload_io_error(error: std::io::Error) -> AppError {
    AppError::Internal(if error.kind() == std::io::ErrorKind::StorageFull {
        localized_error!("backendErrors.file.diskFull")
    } else {
        localized_error!("backendErrors.request.failed", "error" => error.to_string())
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request(files: &[(&str, u64, Option<i64>)], empty_dirs: &[&str]) -> NewUpload {
        NewUpload {
            remote: "drive:".into(),
            path: "destination".into(),
            origin: None,
            group: Some("upload-group".into()),
            options: None,
            entries: entries(files, empty_dirs),
        }
    }

    fn entries(files: &[(&str, u64, Option<i64>)], empty_dirs: &[&str]) -> UploadEntries {
        UploadEntries {
            files: files
                .iter()
                .map(|(path, size, mtime)| NewUploadFile {
                    path: (*path).into(),
                    size: *size,
                    mtime: *mtime,
                })
                .collect(),
            empty_dirs: empty_dirs.iter().map(|dir| (*dir).into()).collect(),
        }
    }

    fn staging_path(session: &UploadSession) -> PathBuf {
        session
            .staging
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .path()
            .to_owned()
    }

    fn body(data: &[u8]) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Unpin {
        futures::stream::iter([Ok(Bytes::copy_from_slice(data))])
    }

    fn is_empty(directory: &Path) -> bool {
        std::fs::read_dir(directory).unwrap().next().is_none()
    }

    fn message(error: AppError) -> String {
        match error {
            AppError::BadRequest(message)
            | AppError::Forbidden(message)
            | AppError::NotFound(message)
            | AppError::Locked(message)
            | AppError::Internal(message) => message,
        }
    }

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

    #[tokio::test]
    async fn chunks_assemble_the_file_and_set_its_modification_time_at_the_end() {
        let root = tempfile::tempdir().unwrap();
        let session = stage_session(
            root.path(),
            request(&[("folder/one.txt", 6, Some(0))], &[]),
            None,
        )
        .await
        .unwrap();
        let file = staging_path(&session).join("folder/one.txt");
        assert_eq!(session.write_chunk(0, 0, body(b"abc")).await.unwrap(), 3);
        assert!(!session.is_complete());
        assert_eq!(session.write_chunk(0, 3, body(b"def")).await.unwrap(), 6);
        assert!(session.is_complete());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "abcdef");
        assert_eq!(
            std::fs::metadata(file).unwrap().modified().unwrap(),
            SystemTime::UNIX_EPOCH
        );
        assert_eq!(session.transfer.group.as_deref(), Some("upload-group"));
    }

    #[tokio::test]
    async fn a_repeated_or_misplaced_chunk_is_not_written_and_reports_the_position() {
        let root = tempfile::tempdir().unwrap();
        let session = stage_session(root.path(), request(&[("a.txt", 4, None)], &[]), None)
            .await
            .unwrap();
        session.write_chunk(0, 0, body(b"ab")).await.unwrap();
        // The answer to the first chunk was lost and the page sends it again.
        assert_eq!(session.write_chunk(0, 0, body(b"ab")).await.unwrap(), 2);
        assert_eq!(session.write_chunk(0, 3, body(b"d")).await.unwrap(), 2);
        assert_eq!(session.write_chunk(0, 2, body(b"")).await.unwrap(), 2);
        assert_eq!(session.write_chunk(0, 2, body(b"cd")).await.unwrap(), 4);
        assert_eq!(
            std::fs::read_to_string(staging_path(&session).join("a.txt")).unwrap(),
            "abcd"
        );
    }

    #[tokio::test]
    async fn a_chunk_is_written_as_it_arrives_and_a_dropped_one_keeps_what_came() {
        let root = tempfile::tempdir().unwrap();
        let session = stage_session(root.path(), request(&[("a.txt", 6, Some(0))], &[]), None)
            .await
            .unwrap();
        let dropped = futures::stream::iter([
            Ok(Bytes::from_static(b"ab")),
            Ok(Bytes::from_static(b"c")),
            Err(std::io::Error::from(std::io::ErrorKind::ConnectionReset)),
        ]);
        assert!(session.write_chunk(0, 0, dropped).await.is_err());
        assert_eq!(session.remaining(), 3);
        // The page sends the chunk again from the start; the server says where to go on.
        assert_eq!(session.write_chunk(0, 0, body(b"abcdef")).await.unwrap(), 3);
        let rest = futures::stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"d")),
            Ok(Bytes::from_static(b"ef")),
        ]);
        assert_eq!(session.write_chunk(0, 3, rest).await.unwrap(), 6);
        let file = staging_path(&session).join("a.txt");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "abcdef");
        assert_eq!(
            std::fs::metadata(file).unwrap().modified().unwrap(),
            SystemTime::UNIX_EPOCH
        );
    }

    #[tokio::test]
    async fn chunks_beyond_a_file_or_for_an_unknown_file_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let session = stage_session(root.path(), request(&[("a.txt", 2, None)], &[]), None)
            .await
            .unwrap();
        for (index, data) in [(0, &b"abc"[..]), (1, &b"a"[..])] {
            assert!(
                message(session.write_chunk(index, 0, body(data)).await.unwrap_err())
                    .contains("backendErrors.upload.invalidChunk")
            );
        }
        assert_eq!(session.remaining(), 2);
    }

    #[tokio::test]
    async fn empty_files_and_folders_are_complete_from_the_start() {
        let root = tempfile::tempdir().unwrap();
        let session = stage_session(
            root.path(),
            request(&[("c/empty.txt", 0, Some(-1000))], &["a/b", "c\\d"]),
            None,
        )
        .await
        .unwrap();
        assert!(session.is_complete());
        let staging = staging_path(&session);
        assert!(staging.join("a/b").is_dir());
        assert!(staging.join("c/d").is_dir());
        assert_eq!(
            std::fs::metadata(staging.join("c/empty.txt"))
                .unwrap()
                .modified()
                .unwrap(),
            SystemTime::UNIX_EPOCH - Duration::from_secs(1)
        );
        let mut tops = top_level_entries(&staging).await.unwrap();
        tops.sort();
        assert_eq!(
            tops,
            [staging.join("a"), staging.join("c")].map(|path| path.to_string_lossy().into_owned())
        );
    }

    #[tokio::test]
    async fn invalid_sessions_are_refused_and_leave_nothing_behind() {
        let root = tempfile::tempdir().unwrap();
        for rejected in [
            request(&[], &[]),
            request(&[("same.txt", 1, None), ("same.txt", 1, None)], &[]),
            request(&[("ok.txt", 1, None), ("../escape.txt", 1, None)], &[]),
            request(&[("ok.txt", 1, None)], &["a//b"]),
        ] {
            assert!(stage_session(root.path(), rejected, None).await.is_err());
            assert!(is_empty(root.path()));
        }
    }

    #[tokio::test]
    async fn an_upload_larger_than_the_free_space_is_refused_before_it_starts() {
        let root = tempfile::tempdir().unwrap();
        let too_big = request(&[("a.bin", 6, None), ("b.bin", 5, None)], &[]);
        let Err(error) = stage_session(root.path(), too_big, Some(10)).await else {
            panic!("an upload larger than the free space was staged");
        };
        assert!(message(error).contains("backendErrors.file.diskFull"));
        assert!(is_empty(root.path()));
        let fits = request(&[("a.bin", 6, None), ("b.bin", 4, None)], &[]);
        assert!(stage_session(root.path(), fits, Some(10)).await.is_ok());
    }

    #[tokio::test]
    async fn later_lists_add_files_in_order_and_a_repeated_list_changes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let session = stage_session(root.path(), request(&[("a.txt", 1, None)], &[]), None)
            .await
            .unwrap();
        let more = entries(&[("folder/b.txt", 2, None), ("c.txt", 0, None)], &["empty"]);
        session.add_entries(1, &more, None).await.unwrap();
        // The answer to that list was lost and the page sends it again.
        session.add_entries(1, &more, None).await.unwrap();
        assert_eq!(session.files().len(), 3);
        assert_eq!(session.remaining(), 3);
        assert_eq!(session.write_chunk(1, 0, body(b"bb")).await.unwrap(), 2);
        let staging = staging_path(&session);
        assert_eq!(
            std::fs::read_to_string(staging.join("folder/b.txt")).unwrap(),
            "bb"
        );
        assert!(staging.join("empty").is_dir());

        // Overlapping the end, or leaving a gap after it.
        for start in [2, 5] {
            let gap = entries(&[("d.txt", 1, None), ("e.txt", 1, None)], &[]);
            assert!(
                message(session.add_entries(start, &gap, None).await.unwrap_err())
                    .contains("backendErrors.upload.invalidChunk"),
                "{start}"
            );
        }
        let Err(error) = session
            .add_entries(3, &entries(&[("big.bin", 11, None)], &[]), Some(10))
            .await
        else {
            panic!("a list larger than the free space was added");
        };
        assert!(message(error).contains("backendErrors.file.diskFull"));
        assert_eq!(session.files().len(), 3);
    }

    #[test]
    fn the_disk_of_an_existing_directory_reports_its_free_space() {
        let temp = tempfile::tempdir().unwrap();
        assert!(available_space(temp.path()).is_some());
        assert_eq!(available_space(&temp.path().join("missing")), None);
    }

    #[tokio::test]
    async fn sessions_reserve_their_remaining_bytes_until_they_end() {
        let root = tempfile::tempdir().unwrap();
        let sessions = UploadSessions::default();
        let session = stage_session(root.path(), request(&[("a.txt", 5, None)], &[]), None)
            .await
            .unwrap();
        let id = sessions.insert(session);
        sessions
            .get(&id)
            .unwrap()
            .write_chunk(0, 0, body(b"ab"))
            .await
            .unwrap();
        assert_eq!(sessions.remaining(), 3);
        let removed = sessions.remove(&id).unwrap();
        removed.discard().await;
        assert_eq!(sessions.remaining(), 0);
        assert!(sessions.get(&id).is_none());
        assert!(is_empty(root.path()));
    }

    #[tokio::test]
    async fn an_abandoned_session_is_removed_with_its_files_and_an_active_one_kept() {
        let root = tempfile::tempdir().unwrap();
        let sessions = Arc::new(UploadSessions::default());
        let timeout = Duration::from_millis(200);
        let mut ids = Vec::new();
        for name in ["abandoned.txt", "active.txt"] {
            let session = stage_session(root.path(), request(&[(name, 4, None)], &[]), None)
                .await
                .unwrap();
            let id = sessions.insert(session);
            expire_when_idle(sessions.clone(), id.clone(), timeout);
            ids.push(id);
        }
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_millis(80)).await;
            sessions.get(&ids[1]).unwrap().touch();
        }
        assert!(sessions.get(&ids[0]).is_none());
        assert!(sessions.get(&ids[1]).is_some());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn the_api_takes_chunks_refuses_large_ones_and_answers_with_translation_keys() {
        use axum::{
            body::{Body, to_bytes},
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;

        let temp = tempfile::tempdir().unwrap();
        let app = AppHandle::default();
        app.manage(crate::services::paths::AppPaths {
            config_dir: temp.path().join("config"),
            cache_dir: temp.path().join("cache"),
            logs_dir: temp.path().join("logs"),
            resource_dir: temp.path().join("resources"),
        });
        let bridge = Arc::new(crate::services::bridge::EventBridge::new(10, None));
        let router = crate::web::routes::build_api_router(WebServerState::new(
            app.clone(),
            bridge,
            None,
            false,
        ));
        let call = |method: &str, uri: String, body: Body| {
            let router = router.clone();
            let request = Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(body)
                .unwrap();
            async move {
                let response = router.oneshot(request).await.unwrap();
                let status = response.status();
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                (status, String::from_utf8_lossy(&body).into_owned())
            }
        };

        let (status, body) = call(
            "POST",
            "/upload/sessions".into(),
            Body::from(
                serde_json::json!({
                    "remote": "drive:",
                    "path": "",
                    "files": [{"path": "a.txt", "size": 3, "mtime": 0}, {"path": "b.txt", "size": 1}],
                })
                .to_string(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let id = serde_json::from_str::<serde_json::Value>(&body).unwrap()["data"]
            .as_str()
            .unwrap()
            .to_owned();

        let (status, body) = call(
            "POST",
            format!("/upload/sessions/{id}/files?start=2"),
            Body::from(serde_json::json!({"files": [{"path": "c.txt", "size": 1}]}).to_string()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let chunk = format!("/upload/sessions/{id}/files/0?offset=0");
        let (status, body) = call("PUT", chunk.clone(), Body::from("abc")).await;
        assert_eq!(
            (status, body.contains("\"data\":3")),
            (StatusCode::OK, true),
            "{body}"
        );
        // A reloaded page reads what arrived of each file, in the page's order.
        let (status, body) = call("GET", format!("/upload/sessions/{id}"), Body::empty()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["data"],
            serde_json::json!([
                {"path": "a.txt", "size": 3, "mtime": 0, "received": 3},
                {"path": "b.txt", "size": 1, "mtime": null, "received": 0},
                {"path": "c.txt", "size": 1, "mtime": null, "received": 0},
            ])
        );

        // Larger than any list may be, and still only refused for not fitting its file.
        let (status, body) = call(
            "PUT",
            format!("/upload/sessions/{id}/files/1?offset=0"),
            Body::from(vec![0; MAX_LIST_BYTES + 1]),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("backendErrors.upload.invalidChunk"), "{body}");

        let (status, body) = call(
            "POST",
            format!("/upload/sessions/{id}/finish"),
            Body::empty(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("backendErrors.upload.incomplete"), "{body}");

        let (status, _) = call("DELETE", format!("/upload/sessions/{id}"), Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(is_empty(&upload_staging_root(&app)));
        let (status, body) = call(
            "PUT",
            format!("/upload/sessions/{id}/files/1?offset=0"),
            Body::from("x"),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains("backendErrors.upload.sessionGone"), "{body}");
        let (status, body) = call("GET", format!("/upload/sessions/{id}"), Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains("backendErrors.upload.sessionGone"), "{body}");

        let (status, body) = call("POST", "/upload".into(), Body::from("old multipart")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("backendErrors.upload.legacyBatch"), "{body}");
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
        assert!(message(error).contains("backendErrors.file.diskFull"));
    }

    #[tokio::test]
    async fn staged_files_are_removed_whether_the_transfer_succeeds_or_fails() {
        let root = tempfile::tempdir().unwrap();
        for outcome in [Ok("job"), Err("transfer failed")] {
            let session = stage_session(root.path(), request(&[("a.txt", 0, None)], &[]), None)
                .await
                .unwrap();
            let staging = session.staging.lock().unwrap().take().unwrap();
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
