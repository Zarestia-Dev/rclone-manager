use lofty::prelude::*;
use lofty::probe::Probe;
use std::io::Cursor;
use std::path::Path;

/// Result of a picture extraction
pub struct PictureData {
    pub data: Vec<u8>,
    pub mime_type: String,
}

/// Extracts the first picture from a local audio file
pub fn extract_picture_from_path(path: &str) -> Option<PictureData> {
    let file_path = Path::new(path);

    if !file_path.exists() || !file_path.is_file() {
        return None;
    }

    let tagged_file = match Probe::open(file_path) {
        Ok(p) => match p.read() {
            Ok(t) => t,
            Err(e) => {
                log::warn!("Failed to read tags from {path}: {e}");
                return None;
            }
        },
        Err(e) => {
            log::warn!("Failed to probe file {path}: {e}");
            return None;
        }
    };

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    if let Some(tag) = tag
        && let Some(pic) = tag.pictures().first()
    {
        return Some(PictureData {
            data: pic.data().to_vec(),
            mime_type: pic
                .mime_type()
                .map(|m| m.to_string())
                .unwrap_or_else(|| "image/jpeg".to_string()),
        });
    }

    None
}

/// Extracts the first picture from an in-memory byte slice
pub fn extract_picture_from_bytes(data: &[u8], extension: Option<&str>) -> Option<PictureData> {
    let mut cursor = Cursor::new(data);

    let mut probe = Probe::new(&mut cursor);

    // Provide extension hint if available (lofty uses this if magic number detection fails)
    if let Some(ext) = extension
        && let Some(mime) = lofty::file::FileType::from_ext(ext)
    {
        probe = probe.set_file_type(mime);
    }

    let tagged_file = match probe.read() {
        Ok(t) => t,
        Err(e) => {
            log::warn!("Failed to read tags from bytes (ext={:?}): {e}", extension);
            return None;
        }
    };

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    if let Some(tag) = tag
        && let Some(pic) = tag.pictures().first()
    {
        return Some(PictureData {
            data: pic.data().to_vec(),
            mime_type: pic
                .mime_type()
                .map(|m| m.to_string())
                .unwrap_or_else(|| "image/jpeg".to_string()),
        });
    }

    None
}
