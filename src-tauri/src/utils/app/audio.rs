use base64::{Engine as _, engine::general_purpose};
use id3::Tag;
use std::path::Path;
use tauri::command;

/// Extracts the cover art from an audio file and returns it as a Base64 encoded string
/// prefixed with the appropriate data URI scheme (e.g., `data:image/jpeg;base64,...`).
pub fn extract_audio_cover(path: &str) -> Result<Option<String>, String> {
    let file_path = Path::new(path);

    if !file_path.exists() || !file_path.is_file() {
        return Err("File does not exist or is not a local file".to_string());
    }

    // Try reading ID3 tags
    let tag = match Tag::read_from_path(file_path) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("Failed to read ID3 tags for {}: {}", path, e);
            return Ok(None);
        }
    };

    // Find the first picture
    if let Some(pic) = tag.pictures().next() {
        let mime_type = &pic.mime_type;
        let b64_data = general_purpose::STANDARD_NO_PAD.encode(&pic.data);
        return Ok(Some(format!("data:{};base64,{}", mime_type, b64_data)));
    }

    Ok(None)
}

/// Extracts the cover art from ID3 tags in an in-memory byte slice
pub fn extract_audio_cover_from_bytes(data: &[u8]) -> Result<Option<String>, String> {
    use std::io::Cursor;

    let mut cursor = Cursor::new(data);

    let tag = match Tag::read_from2(&mut cursor) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("Failed to read ID3 tags from memory: {}", e);
            return Ok(None);
        }
    };

    // Find the first picture
    if let Some(pic) = tag.pictures().next() {
        let mime_type = &pic.mime_type;
        let b64_data = general_purpose::STANDARD_NO_PAD.encode(&pic.data);
        return Ok(Some(format!("data:{};base64,{}", mime_type, b64_data)));
    }

    Ok(None)
}

#[command]
pub async fn get_audio_cover(
    remote: String,
    path: String,
    is_local: bool,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use crate::rclone::backend::BackendManager;
    use crate::utils::types::core::RcloneState;
    use tauri::Manager;

    if is_local {
        // Construct local path
        let separator = if remote.ends_with('/') || remote.ends_with('\\') {
            ""
        } else {
            "/"
        };
        let full_path = format!("{}{}{}", remote, separator, path);
        return extract_audio_cover(&full_path);
    }

    // Remote extraction
    let backend_manager = app.state::<BackendManager>();
    let backend: crate::rclone::backend::types::Backend = backend_manager.get_active().await;

    let rclone_state = app.state::<RcloneState>();
    let client = &rclone_state.client;

    // Request the first 1MB to find tags
    let range_header = Some("bytes=0-1048576");

    match backend
        .fetch_file_stream_with_range(client, &remote, &path, range_header)
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response.bytes().await {
                    Ok(bytes) => extract_audio_cover_from_bytes(&bytes),
                    Err(e) => {
                        log::warn!("Failed to read stream bytes for audio cover: {}", e);
                        Ok(None)
                    }
                }
            } else {
                log::warn!(
                    "Failed to fetch remote stream for cover: {}",
                    response.status()
                );
                Ok(None)
            }
        }
        Err(e) => {
            log::warn!("Proxy error fetching audio cover: {}", e);
            Ok(None)
        }
    }
}
