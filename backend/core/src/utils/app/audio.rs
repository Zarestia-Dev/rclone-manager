use std::io::Cursor;
use std::path::Path;

use lofty::file::TaggedFile;
use lofty::prelude::*;
use lofty::probe::Probe;

/// Result of a picture extraction
pub struct PictureData {
    pub data: Vec<u8>,
    pub mime_type: String,
}

static COVER_TASKS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static COVER_INPUTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Acquire before buffering a remote cover, not after its bytes occupy RAM.
pub async fn cover_input_permit() -> Option<tokio::sync::SemaphorePermit<'static>> {
    COVER_INPUTS.acquire().await.ok()
}

struct CancelProbe(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for CancelProbe {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

async fn picture_task(
    work: impl FnOnce(std::sync::Arc<std::sync::atomic::AtomicBool>) -> Option<PictureData>
    + Send
    + 'static,
) -> Option<PictureData> {
    let permit = COVER_TASKS.acquire().await.ok()?;
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _guard = CancelProbe(cancel.clone());
    crate::utils::spawn_blocking(move || {
        let _permit = permit;
        work(cancel)
    })
    .await
    .ok()
    .flatten()
}

pub async fn extract_picture_from_path(path: String) -> Option<PictureData> {
    picture_task(move |cancel| {
        // Opening a FIFO can block before the post-open metadata check runs.
        if !std::fs::metadata(&path).ok()?.is_file() {
            return None;
        }
        let file = std::fs::File::open(&path).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let extension = Path::new(&path).extension().and_then(|ext| ext.to_str());
        probe_picture(file, extension, cancel)
    })
    .await
}

pub async fn extract_picture_from_bytes(
    data: Vec<u8>,
    extension: Option<String>,
) -> Option<PictureData> {
    picture_task(move |cancel| probe_picture(Cursor::new(data), extension.as_deref(), cancel)).await
}

/// Bound cumulative reads while preserving Seek, including formats with tags
/// at the end of a file. Cancellation is checked at each parser I/O operation.
struct ProbeReader<R> {
    reader: R,
    remaining: u64,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl<R> ProbeReader<R> {
    fn check_cancelled(&self) -> std::io::Result<()> {
        if self.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "Cover probe cancelled",
            ))
        } else {
            Ok(())
        }
    }
}
impl<R: std::io::Read> std::io::Read for ProbeReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.check_cancelled()?;
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            return Err(std::io::Error::other("Cover probe byte limit exceeded"));
        }
        let length = buffer.len().min(self.remaining as usize);
        let count = self.reader.read(&mut buffer[..length])?;
        self.remaining -= count as u64;
        Ok(count)
    }
}
impl<R: std::io::Seek> std::io::Seek for ProbeReader<R> {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.check_cancelled()?;
        self.reader.seek(position)
    }
}

fn probe_picture<R: std::io::Read + std::io::Seek>(
    reader: R,
    extension: Option<&str>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Option<PictureData> {
    let reader = ProbeReader {
        reader,
        remaining: crate::utils::io::http_helpers::MAX_AUDIO_COVER_PROBE_BYTES,
        cancel,
    };
    let mut probe = Probe::new(reader);
    if let Some(kind) = extension.and_then(lofty::file::FileType::from_ext) {
        probe = probe.set_file_type(kind);
    } else {
        probe = probe.guess_file_type().ok()?;
    }
    match probe.read() {
        Ok(file) => picture_from_tagged_file(&file),
        Err(error) => {
            log::debug!("Audio cover probe stopped: {error}");
            None
        }
    }
}

fn picture_from_tagged_file(tagged_file: &TaggedFile) -> Option<PictureData> {
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    if let Some(tag) = tag
        && let Some(pic) = tag.pictures().first()
    {
        return Some(PictureData {
            data: pic.data().to_vec(),
            mime_type: pic.mime_type().map_or_else(
                || "image/jpeg".to_string(),
                std::string::ToString::to_string,
            ),
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn probe_budget_counts_reads_even_after_seeking() {
        let mut reader = ProbeReader {
            reader: Cursor::new(b"abc"),
            remaining: 3,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        reader.seek(SeekFrom::Start(0)).unwrap();
        reader.read_exact(&mut [0; 2]).unwrap();
        assert!(reader.read(&mut byte).is_err());
    }

    #[test]
    fn cancelled_probe_stops_reads_and_seeks() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut reader = ProbeReader {
            reader: Cursor::new(b"abc"),
            remaining: 3,
            cancel: cancel.clone(),
        };
        let guard = CancelProbe(cancel.clone());
        drop(guard);
        assert!(cancel.load(Ordering::Relaxed));
        assert_eq!(
            reader.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::ConnectionAborted
        );
        assert!(reader.seek(SeekFrom::Start(0)).is_err());
    }
}
