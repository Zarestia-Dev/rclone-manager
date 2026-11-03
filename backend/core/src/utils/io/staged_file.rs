//! Writing a local file without ever exposing a half-written result.
use std::path::Path;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Copy granularity; also how often a caller's check runs.
const COPY_CHUNK: usize = 64 * 1024;

/// A file being written. Staged files live beside their destination under a temporary
/// name and replace it only on [`commit`](Self::commit); dropping one uncommitted
/// leaves an existing destination untouched and removes the temporary file.
pub struct StagedFile {
    file: tokio::fs::File,
    temporary: Option<tempfile::NamedTempFile>,
}

impl StagedFile {
    /// Stages a replacement for `destination`, creating its parent directories.
    pub async fn create(destination: &Path) -> std::io::Result<Self> {
        let parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
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
        Ok(Self {
            file: tokio::fs::File::from_std(file),
            temporary: Some(temporary),
        })
    }

    /// Writes straight into `file`, for targets that cannot be replaced atomically
    /// (such as Android storage-provider descriptors).
    pub fn in_place(file: tokio::fs::File) -> Self {
        Self {
            file,
            temporary: None,
        }
    }

    pub fn writer(&mut self) -> &mut tokio::fs::File {
        &mut self.file
    }

    /// Flushes the data and, for a staged file, moves it onto `destination`.
    pub async fn commit(mut self, destination: &Path) -> std::io::Result<()> {
        self.file.flush().await?;
        let Some(temporary) = self.temporary else {
            return Ok(());
        };
        self.file.sync_all().await?;
        drop(self.file);
        let destination = destination.to_path_buf();
        crate::utils::spawn_blocking(move || {
            temporary
                .persist(destination)
                .map(|_| ())
                .map_err(|e| e.error)
        })
        .await
        .map_err(std::io::Error::other)?
    }
}

/// Why [`copy_in_chunks`] stopped.
#[derive(Debug)]
pub enum CopyError {
    Io(std::io::Error),
    /// The `on_chunk` callback refused to continue, with its message.
    Aborted(String),
}

/// Copies `reader` into `writer` in bounded chunks and returns the bytes copied.
/// `on_chunk` receives the running total after each read, before it is written, and
/// can stop the copy (for example when the session that asked for it has ended).
pub async fn copy_in_chunks(
    reader: &mut (impl AsyncRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
    mut on_chunk: impl FnMut(u64) -> Result<(), String>,
) -> Result<u64, CopyError> {
    let mut buffer = vec![0; COPY_CHUNK];
    let mut copied = 0u64;
    loop {
        let read = reader.read(&mut buffer).await.map_err(CopyError::Io)?;
        if read == 0 {
            return Ok(copied);
        }
        copied += read as u64;
        on_chunk(copied).map_err(CopyError::Aborted)?;
        writer
            .write_all(&buffer[..read])
            .await
            .map_err(CopyError::Io)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unfinished_download_preserves_existing_destination_and_cleans_up() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("song.mp3");
        tokio::fs::write(&destination, b"original").await.unwrap();
        let mut staged = StagedFile::create(&destination).await.unwrap();
        let temporary_path = staged.temporary.as_ref().unwrap().path().to_owned();
        staged.writer().write_all(b"partial").await.unwrap();
        drop(staged);
        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"original");
        assert!(!temporary_path.exists());
    }

    #[tokio::test]
    async fn committing_replaces_the_destination_and_creates_parents() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("new/dir/song.mp3");
        let mut staged = StagedFile::create(&destination).await.unwrap();
        staged.writer().write_all(b"complete").await.unwrap();
        staged.commit(&destination).await.unwrap();
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"complete");
    }

    #[tokio::test]
    async fn downloading_a_file_to_itself_preserves_its_contents() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("song.mp3");
        tokio::fs::write(&destination, b"complete source")
            .await
            .unwrap();
        let mut staged = StagedFile::create(&destination).await.unwrap();
        let mut source = tokio::fs::File::open(&destination).await.unwrap();
        copy_in_chunks(&mut source, staged.writer(), |_| Ok(()))
            .await
            .unwrap();
        staged.commit(&destination).await.unwrap();
        assert_eq!(
            tokio::fs::read(destination).await.unwrap(),
            b"complete source"
        );
    }

    #[tokio::test]
    async fn in_place_files_are_written_directly() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("provider");
        let mut staged = StagedFile::in_place(tokio::fs::File::create(&path).await.unwrap());
        staged.writer().write_all(b"direct").await.unwrap();
        staged.commit(&path).await.unwrap();
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"direct");
    }

    #[tokio::test]
    async fn copying_reports_progress_and_stops_when_refused() {
        let data = vec![7u8; COPY_CHUNK * 2 + 5];
        let mut sink = Vec::new();
        let mut seen = Vec::new();
        let copied = copy_in_chunks(&mut data.as_slice(), &mut sink, |total| {
            seen.push(total);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(copied, data.len() as u64);
        assert_eq!(sink, data);
        assert_eq!(seen.last(), Some(&(data.len() as u64)));

        let mut sink = Vec::new();
        let stopped =
            copy_in_chunks(&mut data.as_slice(), &mut sink, |_| Err("locked".into())).await;
        assert!(matches!(&stopped, Err(CopyError::Aborted(message)) if message == "locked"));
        assert!(sink.is_empty(), "nothing is written after the refusal");
    }
}
