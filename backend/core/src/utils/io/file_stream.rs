//! Shared remote file metadata and bounded, pull-driven reads for HTTP and native protocols.
use crate::rclone::backend::{RcloneTransport, transport::BackendError};
use futures::stream;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tokio_util::io::StreamReader;

pub const FILE_CHUNK_SIZE: u64 = 2 * 1024 * 1024;

/// Call once before stat so metadata and byte reads share the same backend.
pub async fn pin_file_transport(
    transport: Arc<dyn RcloneTransport>,
) -> Result<Arc<dyn RcloneTransport>, BackendError> {
    Ok(transport.for_file_read().await?.unwrap_or(transport))
}

/// Split local paths independently of the host OS (a daemon can run on another OS).
pub fn file_location<'a>(remote: &'a str, path: &'a str) -> (&'a str, &'a str) {
    if !remote.is_empty() && remote != ":" {
        return (remote, path);
    }
    match path.rfind(['/', '\\']) {
        Some(index) => (&path[..=index], &path[index + 1..]),
        None => (".", path),
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct FileVersion {
    pub size: u64,
    id: Option<String>,
    modified: Option<String>,
}

pub async fn file_metadata(
    transport: &dyn RcloneTransport,
    remote: &str,
    path: &str,
) -> Result<FileVersion, BackendError> {
    let (remote, path) = file_location(remote, path);
    let payload = serde_json::json!({"fs": remote, "remote": path, "opt": {"noMimeType": true}});
    let value = transport
        .rpc(crate::rclone::endpoints::operations::STAT, Some(&payload))
        .await?;
    let item = &value["item"];
    if item.is_null() {
        return Err(BackendError::Other("File not found".into()));
    }
    if item["IsDir"].as_bool() == Some(true) {
        return Err(BackendError::Other(
            "Permission denied: cannot stream a directory".into(),
        ));
    }
    let size = item["Size"]
        .as_u64()
        .ok_or_else(|| BackendError::Other("File size unavailable".into()))?;
    Ok(FileVersion {
        size,
        id: item["ID"].as_str().map(str::to_owned),
        modified: item["ModTime"].as_str().map(str::to_owned),
    })
}

struct FileReadState {
    transport: Arc<dyn RcloneTransport>,
    remote: String,
    path: String,
    offset: u64,
    remaining: u64,
    version: Option<FileVersion>,
    initialized: bool,
    reader: Option<Box<dyn AsyncRead + Unpin + Send>>,
    checked: tokio::time::Instant,
}

impl FileReadState {
    async fn verify_version(&mut self) -> std::io::Result<()> {
        let current = file_metadata(self.transport.as_ref(), &self.remote, &self.path)
            .await
            .map_err(std::io::Error::other)?;
        if self
            .version
            .as_ref()
            .is_some_and(|version| version != &current)
        {
            return Err(std::io::Error::other("File changed during streaming"));
        }
        self.version = Some(current);
        self.checked = tokio::time::Instant::now();
        Ok(())
    }
}

/// HTTP streams keep one connection; RPC reads stay bounded. Dropping this
/// reader drops the active HTTP body and prevents subsequent RPC chunks.
pub fn file_reader(
    transport: Arc<dyn RcloneTransport>,
    remote: String,
    path: String,
    start: u64,
    length: u64,
    version: Option<FileVersion>,
) -> impl AsyncRead + Unpin + Send {
    let state = FileReadState {
        transport,
        remote,
        path,
        offset: start,
        remaining: length,
        version,
        initialized: false,
        reader: None,
        checked: tokio::time::Instant::now(),
    };
    let chunks = stream::try_unfold(state, |mut state| async move {
        if state.remaining == 0 {
            return Ok(None);
        }
        if !state.initialized {
            let end = state
                .offset
                .checked_add(state.remaining)
                .and_then(|end| end.checked_sub(1))
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "File range overflow")
                })?;
            state.verify_version().await?;
            state.initialized = true;
            state.reader = state
                .transport
                .open_file_stream(&state.remote, &state.path, (state.offset, end))
                .await
                .map_err(std::io::Error::other)?;
        } else if state.checked.elapsed() >= std::time::Duration::from_secs(1) {
            state.verify_version().await?;
        }
        let count = state.remaining.min(if state.reader.is_some() {
            64 * 1024
        } else {
            FILE_CHUNK_SIZE
        });
        let next_offset = state.offset.checked_add(count).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "File range overflow")
        })?;
        let mut bytes = Vec::with_capacity(count as usize);
        if let Some(reader) = &mut state.reader {
            reader.take(count).read_to_end(&mut bytes).await?;
        } else {
            let mut reader = state
                .transport
                .read_file(
                    &state.remote,
                    &state.path,
                    Some((state.offset, Some(next_offset - 1))),
                )
                .await
                .map_err(std::io::Error::other)?;
            (&mut reader).take(count).read_to_end(&mut bytes).await?;
        }
        if bytes.len() as u64 != count {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "File changed or truncated during streaming",
            ));
        }
        state.offset = next_offset;
        state.remaining -= count;
        // Check again before exposing the last bytes, including same-size edits.
        if state.remaining == 0 {
            state.verify_version().await?;
        }
        Ok(Some((std::io::Cursor::new(bytes), state)))
    });
    StreamReader::new(Box::pin(chunks))
}

/// Stream an already-open local file while detecting in-place writes and truncation.
pub fn local_file_reader(
    file: tokio::fs::File,
    metadata: std::fs::Metadata,
    length: u64,
) -> impl AsyncRead + Unpin + Send {
    let chunks = stream::try_unfold(
        (file, metadata, length, tokio::time::Instant::now()),
        |(mut file, original, remaining, mut checked)| async move {
            if remaining == 0 {
                return Ok(None);
            }
            let count = remaining.min(64 * 1024);
            let mut bytes = Vec::with_capacity(count as usize);
            (&mut file).take(count).read_to_end(&mut bytes).await?;
            if bytes.len() as u64 != count {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Local file truncated during streaming",
                ));
            }
            if remaining == count || checked.elapsed() >= std::time::Duration::from_secs(1) {
                let current = file.metadata().await?;
                if current.len() != original.len()
                    || current.modified().ok() != original.modified().ok()
                {
                    return Err(std::io::Error::other("Local file changed during streaming"));
                }
                checked = tokio::time::Instant::now();
            }
            Ok(Some((
                std::io::Cursor::new(bytes),
                (file, original, remaining - count, checked),
            )))
        },
    );
    StreamReader::new(Box::pin(chunks))
}

/// Reported for directories and special files; classifies as HTTP 403.
const NOT_A_REGULAR_FILE: &str = "Permission denied: only regular files can be streamed";

/// A readable file: opened directly when this host can, otherwise through rclone.
pub enum AssetSource {
    Local {
        file: tokio::fs::File,
        metadata: std::fs::Metadata,
    },
    Remote {
        transport: Arc<dyn RcloneTransport>,
        remote: String,
        path: String,
        version: FileVersion,
    },
}

impl AssetSource {
    pub fn total(&self) -> u64 {
        match self {
            Self::Local { metadata, .. } => metadata.len(),
            Self::Remote { version, .. } => version.size,
        }
    }

    /// Reads `length` bytes from `start`, failing if the file changes meanwhile.
    pub async fn into_reader(
        self,
        start: u64,
        length: u64,
    ) -> std::io::Result<Box<dyn AsyncRead + Unpin + Send>> {
        match self {
            Self::Local { mut file, metadata } => {
                file.seek(std::io::SeekFrom::Start(start)).await?;
                Ok(Box::new(local_file_reader(file, metadata, length)))
            }
            Self::Remote {
                transport,
                remote,
                path,
                version,
            } => Ok(Box::new(file_reader(
                transport,
                remote,
                path,
                start,
                length,
                Some(version),
            ))),
        }
    }
}

/// Opens `path` for ranged reads. An empty `remote` means a path on the host: it is
/// opened directly, and only read through rclone when the host cannot open it
/// (for example Android storage providers). Directories are never served.
pub async fn open_asset(
    transport: Arc<dyn RcloneTransport>,
    remote: &str,
    path: &str,
) -> Result<AssetSource, String> {
    if remote.is_empty()
        && let Some(local) = open_local_regular_file(path).await?
    {
        return Ok(local);
    }
    let transport = pin_file_transport(transport)
        .await
        .map_err(|e| e.to_string())?;
    let version = file_metadata(transport.as_ref(), remote, path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(AssetSource::Remote {
        transport,
        remote: remote.to_string(),
        path: path.to_string(),
        version,
    })
}

/// `Ok(None)` when the file cannot be opened here, so the caller may try rclone.
async fn open_local_regular_file(path: &str) -> Result<Option<AssetSource>, String> {
    // Checked before opening: opening a FIFO can block.
    if let Ok(metadata) = tokio::fs::metadata(path).await
        && !metadata.is_file()
    {
        return Err(NOT_A_REGULAR_FILE.into());
    }
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) => {
            log::debug!("Direct open of {path} failed, falling back to rclone: {error}");
            return Ok(None);
        }
    };
    let metadata = file.metadata().await.map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err(NOT_A_REGULAR_FILE.into());
    }
    Ok(Some(AssetSource::Local { file, metadata }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::transport::TransportKind;
    use std::sync::Mutex;
    struct Transport {
        size: Mutex<serde_json::Value>,
        reads: Mutex<Vec<(u64, Option<u64>)>>,
        truncate: bool,
        streaming: bool,
    }
    #[async_trait::async_trait]
    impl RcloneTransport for Transport {
        async fn kind(&self) -> TransportKind {
            TransportKind::Librclone
        }
        async fn open_file_stream(
            &self,
            _: &str,
            _: &str,
            range: (u64, u64),
        ) -> Result<Option<Box<dyn AsyncRead + Unpin + Send>>, BackendError> {
            if !self.streaming {
                return Ok(None);
            }
            self.reads.lock().unwrap().push((range.0, Some(range.1)));
            let bytes: Vec<_> = (range.0..=range.1).map(|n| (n % 251) as u8).collect();
            Ok(Some(Box::new(std::io::Cursor::new(bytes))))
        }
        async fn rpc(
            &self,
            endpoint: &str,
            _payload: Option<&serde_json::Value>,
        ) -> Result<serde_json::Value, BackendError> {
            assert_eq!(endpoint, "operations/stat");
            Ok(self.size.lock().unwrap().clone())
        }
        async fn read_file(
            &self,
            _: &str,
            _: &str,
            range: Option<(u64, Option<u64>)>,
        ) -> Result<Box<dyn AsyncRead + Unpin + Send>, BackendError> {
            let (start, end) = range.unwrap();
            self.reads.lock().unwrap().push((start, end));
            let end = end.unwrap();
            let bytes: Vec<u8> = (start..=end).map(|n| (n % 251) as u8).collect();
            let bytes = if self.truncate {
                bytes[..bytes.len() - 1].to_vec()
            } else {
                bytes
            };
            Ok(Box::new(std::io::Cursor::new(bytes)))
        }
    }
    fn transport(size: serde_json::Value, truncate: bool) -> Arc<Transport> {
        Arc::new(Transport {
            size: Mutex::new(if size.is_null() {
                serde_json::json!({"item": {"Size": FILE_CHUNK_SIZE * 10}})
            } else {
                size
            }),
            reads: Mutex::new(vec![]),
            truncate,
            streaming: false,
        })
    }

    #[tokio::test]
    async fn local_same_size_writes_fail_instead_of_mixing_versions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file");
        let length = 64 * 1024 + 17;
        tokio::fs::write(&path, vec![1; length]).await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let metadata = file.metadata().await.unwrap();
        let mut reader = local_file_reader(file, metadata, length as u64);
        assert_eq!(reader.read_u8().await.unwrap(), 1);
        tokio::fs::write(&path, vec![2; length]).await.unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(2))
            .unwrap();
        assert!(
            reader
                .read_to_end(&mut vec![])
                .await
                .unwrap_err()
                .to_string()
                .contains("changed")
        );
    }

    #[tokio::test]
    async fn streaming_backend_opens_once_for_a_multi_chunk_file() {
        let length = FILE_CHUNK_SIZE + 17;
        let t = Arc::new(Transport {
            size: Mutex::new(serde_json::json!({"item": {"Size": length, "ModTime": "first"}})),
            reads: Mutex::new(vec![]),
            truncate: false,
            streaming: true,
        });
        let mut reader = file_reader(t.clone(), "remote:".into(), "file".into(), 0, length, None);
        let mut bytes = vec![];
        reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes.len() as u64, length);
        assert_eq!(*t.reads.lock().unwrap(), vec![(0, Some(length - 1))]);
    }

    #[tokio::test]
    async fn same_size_replacements_fail_before_the_last_chunk_is_exposed() {
        let t = transport(
            serde_json::json!({"item": {"Size": FILE_CHUNK_SIZE + 17, "ID": "file", "ModTime": "first"}}),
            false,
        );
        let mut reader = file_reader(
            t.clone(),
            "remote:".into(),
            "file".into(),
            0,
            FILE_CHUNK_SIZE + 17,
            None,
        );
        reader.read_u8().await.unwrap();
        t.size.lock().unwrap()["item"]["ModTime"] = serde_json::json!("replaced");
        assert!(
            reader
                .read_to_end(&mut vec![])
                .await
                .unwrap_err()
                .to_string()
                .contains("File changed")
        );
    }

    struct SwitchingTransport {
        active: Mutex<Arc<Transport>>,
    }

    #[async_trait::async_trait]
    impl RcloneTransport for SwitchingTransport {
        async fn kind(&self) -> TransportKind {
            TransportKind::HttpDaemon
        }
        async fn for_file_read(&self) -> Result<Option<Arc<dyn RcloneTransport>>, BackendError> {
            Ok(Some(self.active.lock().unwrap().clone()))
        }
        async fn rpc(
            &self,
            endpoint: &str,
            payload: Option<&serde_json::Value>,
        ) -> Result<serde_json::Value, BackendError> {
            let active = self.active.lock().unwrap().clone();
            active.rpc(endpoint, payload).await
        }
        async fn read_file(
            &self,
            remote: &str,
            path: &str,
            range: Option<(u64, Option<u64>)>,
        ) -> Result<Box<dyn AsyncRead + Unpin + Send>, BackendError> {
            let active = self.active.lock().unwrap().clone();
            active.read_file(remote, path, range).await
        }
    }

    #[tokio::test]
    async fn metadata_and_chunks_keep_the_original_backend_after_a_switch() {
        let original = transport(
            serde_json::json!({"item": {"Size": FILE_CHUNK_SIZE + 17}}),
            false,
        );
        let replacement = transport(serde_json::json!({"item": {"Size": 1}}), true);
        let routing = Arc::new(SwitchingTransport {
            active: Mutex::new(original.clone()),
        });
        let pinned = pin_file_transport(routing.clone()).await.unwrap();
        let path = "music/şarkı #1.mp3";
        let size = file_metadata(pinned.as_ref(), "remote:", path)
            .await
            .unwrap()
            .size;
        let mut reader = file_reader(pinned, "remote:".into(), path.into(), 0, size, None);
        assert_eq!(reader.read_u8().await.unwrap(), 0);
        *routing.active.lock().unwrap() = replacement.clone();
        reader.read_to_end(&mut vec![]).await.unwrap();
        assert_eq!(original.reads.lock().unwrap().len(), 2);
        assert!(replacement.reads.lock().unwrap().is_empty());
        // Fixed transports keep their identity without an extra wrapper.
        let fixed: Arc<dyn RcloneTransport> = original;
        assert!(Arc::ptr_eq(
            &fixed,
            &pin_file_transport(fixed.clone()).await.unwrap()
        ));
    }
    #[test]
    fn local_paths_are_split_for_the_daemon_operating_system() {
        assert_eq!(
            file_location("", "/music/song.mp3"),
            ("/music/", "song.mp3")
        );
        assert_eq!(
            file_location("", "C:/music/song.mp3"),
            ("C:/music/", "song.mp3")
        );
        assert_eq!(
            file_location("", r"C:\music\song.mp3"),
            (r"C:\music\", "song.mp3")
        );
        assert_eq!(file_location("", "/song.mp3"), ("/", "song.mp3"));
        assert_eq!(file_location("", "song.mp3"), (".", "song.mp3"));
        assert_eq!(file_location("drive:", "a/b.mp3"), ("drive:", "a/b.mp3"));
    }

    #[tokio::test]
    async fn validates_metadata_including_empty_missing_and_unknown_files() {
        for (item, expected) in [
            (serde_json::json!({"Size": 0, "IsDir": false}), Some(0)),
            (
                serde_json::json!({"Size": 9876, "IsDir": false}),
                Some(9876),
            ),
            (serde_json::json!({"Size": -1}), None),
            (serde_json::json!({"Size": 12, "IsDir": true}), None),
            (serde_json::Value::Null, None),
        ] {
            let t = transport(serde_json::json!({"item": item}), false);
            assert_eq!(
                file_metadata(t.as_ref(), "remote:", "music/şarkı #1.mp3")
                    .await
                    .map(|metadata| metadata.size)
                    .ok(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn streams_exact_bytes_in_bounded_chunks() {
        let t = transport(serde_json::Value::Null, false);
        let length = FILE_CHUNK_SIZE + 17;
        let mut reader = file_reader(
            t.clone(),
            "remote:".into(),
            "file.mp4".into(),
            123,
            length,
            None,
        );
        assert!(t.reads.lock().unwrap().is_empty());
        let mut bytes = vec![];
        reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(
            bytes,
            (123..123 + length)
                .map(|n| (n % 251) as u8)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            *t.reads.lock().unwrap(),
            vec![
                (123, Some(123 + FILE_CHUNK_SIZE - 1)),
                (123 + FILE_CHUNK_SIZE, Some(123 + length - 1))
            ]
        );
    }
    #[tokio::test]
    async fn dropping_reader_stops_future_chunks_and_empty_files_do_not_read() {
        let t = transport(serde_json::Value::Null, false);
        let mut reader = file_reader(
            t.clone(),
            "".into(),
            "file".into(),
            0,
            FILE_CHUNK_SIZE * 3,
            None,
        );
        reader.read_u8().await.unwrap();
        drop(reader);
        assert_eq!(t.reads.lock().unwrap().len(), 1);
        let mut empty = file_reader(t.clone(), "".into(), "empty".into(), 0, 0, None);
        assert_eq!(empty.read(&mut [0]).await.unwrap(), 0);
        assert_eq!(t.reads.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn overflowing_ranges_fail_before_reading_the_backend() {
        let t = transport(serde_json::Value::Null, false);
        let mut reader = file_reader(t.clone(), "".into(), "file".into(), u64::MAX, 2, None);
        assert_eq!(
            reader.read_u8().await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert!(t.reads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn truncated_chunks_fail_instead_of_silently_corrupting_media() {
        let t = transport(serde_json::Value::Null, true);
        let mut reader = file_reader(t, "".into(), "file".into(), 0, 100, None);
        assert_eq!(
            reader.read_to_end(&mut vec![]).await.unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }

    async fn read_all(source: AssetSource, start: u64, length: u64) -> Vec<u8> {
        let mut bytes = vec![];
        source
            .into_reader(start, length)
            .await
            .unwrap()
            .read_to_end(&mut bytes)
            .await
            .unwrap();
        bytes
    }

    #[tokio::test]
    async fn local_files_open_directly_and_support_ranges() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("clip.bin");
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        // The transport must stay untouched: any call would fail the stat assertion.
        let source = open_asset(
            transport(serde_json::json!({}), false),
            "",
            path.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert!(matches!(source, AssetSource::Local { .. }));
        assert_eq!(source.total(), 10);
        assert_eq!(read_all(source, 3, 4).await, b"3456");
    }

    #[tokio::test]
    async fn directories_are_refused_without_asking_rclone() {
        let directory = tempfile::tempdir().unwrap();
        let error = open_asset(
            transport(serde_json::json!({}), false),
            "",
            directory.path().to_str().unwrap(),
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("Permission denied"));
    }

    #[tokio::test]
    async fn unreadable_local_paths_fall_back_to_rclone() {
        let t = transport(serde_json::json!({"item": {"Size": 5, "ID": "x"}}), false);
        let source = open_asset(t.clone(), "", "/definitely/not/here.bin")
            .await
            .unwrap();
        assert!(matches!(source, AssetSource::Remote { .. }));
        assert_eq!(source.total(), 5);
        read_all(source, 1, 3).await;
        assert_eq!(*t.reads.lock().unwrap(), vec![(1, Some(3))]);
    }

    #[tokio::test]
    async fn named_remotes_are_never_opened_locally() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("same-name");
        tokio::fs::write(&path, b"local").await.unwrap();
        let t = transport(serde_json::json!({"item": {"Size": 9, "ID": "x"}}), false);
        let source = open_asset(t, "drive:", path.to_str().unwrap())
            .await
            .unwrap();
        assert!(matches!(source, AssetSource::Remote { .. }));
        assert_eq!(source.total(), 9);
    }
}
