//! Shared HTTP and URI helper utilities.
//!
//! Provides protocol-agnostic URL decoding, path normalization, Range header parsing,
//! protocol prefix stripping, and error-to-status classification shared across both
//! desktop Tauri custom protocol handlers and the headless axum web server.

use http::StatusCode;

/// Maximum number of bytes to probe from the start of an audio file when extracting embedded cover artwork (10 MB).
pub const MAX_AUDIO_COVER_PROBE_BYTES: u64 = 10 * 1024 * 1024;

/// Strips custom protocol prefixes (`scheme://localhost`, `http://scheme.localhost`, `https://scheme.localhost`, `scheme://`).
/// Returns the remaining path slice without re-allocating.
pub fn strip_protocol_prefix<'a>(uri: &'a str, scheme: &str) -> &'a str {
    if let Some(after_scheme) = uri.strip_prefix(scheme) {
        if let Some(rest) = after_scheme.strip_prefix("://localhost") {
            return rest;
        }
        if let Some(rest) = after_scheme.strip_prefix("://") {
            return rest;
        }
    }
    if let Some(after_http) = uri.strip_prefix("http://")
        && let Some(after_scheme) = after_http.strip_prefix(scheme)
        && let Some(rest) = after_scheme.strip_prefix(".localhost")
    {
        return rest;
    }
    if let Some(after_https) = uri.strip_prefix("https://")
        && let Some(after_scheme) = after_https.strip_prefix(scheme)
        && let Some(rest) = after_scheme.strip_prefix(".localhost")
    {
        return rest;
    }
    uri
}

/// Strips custom protocol prefixes and trims any leading slash.
/// Useful for schemes where the first path component is a named resource (e.g. remote or action).
pub fn strip_protocol_prefix_trimmed<'a>(uri: &'a str, scheme: &str) -> &'a str {
    let rest = strip_protocol_prefix(uri, scheme);
    rest.strip_prefix('/').unwrap_or(rest)
}

/// Decodes a URL-encoded string, falling back to the original string on failure.
pub fn url_decode(s: &str) -> String {
    urlencoding::decode(s)
        .map(|d| d.into_owned())
        .unwrap_or_else(|_| s.to_string())
}

/// Decodes a remote name and ensures it terminates with a colon (`:`).
pub fn decode_remote_name(remote: &str) -> String {
    let mut decoded = url_decode(remote);
    if !decoded.ends_with(':') {
        decoded.push(':');
    }
    decoded
}

/// Normalizes a decoded path from a URI:
/// - Collapses multiple leading slashes into a single slash (e.g. `//sdcard/...` -> `/sdcard/...`)
/// - Strips the leading slash if the path represents a Windows drive letter (e.g. `/C:/folder` -> `C:/folder`)
pub fn normalize_asset_path(mut path: String) -> String {
    if path.starts_with("//") {
        let non_slash = path.find(|c| c != '/').unwrap_or(path.len());
        path.replace_range(..non_slash - 1, "");
    }
    if path.starts_with('/') && path.chars().nth(2) == Some(':') {
        path.remove(0);
    }
    path
}

/// Parses a standard HTTP `Range` header of the form `bytes=start-end` or `bytes=start-`.
/// Returns `Some((start, end))` if valid, or `None` otherwise.
pub fn parse_byte_range(range_str: &str) -> Option<(u64, Option<u64>)> {
    let stripped = range_str.strip_prefix("bytes=")?;
    let mut parts = stripped.split('-');
    let start = parts.next()?.parse::<u64>().ok()?;
    let end = match parts.next() {
        Some(s) if !s.is_empty() => Some(s.parse::<u64>().ok()?),
        _ => None,
    };
    Some((start, end))
}

/// Maps an error message to a suitable HTTP status code.
pub fn classify_error_status(err_msg: &str) -> StatusCode {
    let lower = err_msg.to_lowercase();
    if lower.contains("not found")
        || lower.contains("directory not found")
        || lower.contains("object not found")
        || lower.contains("item not found")
    {
        StatusCode::NOT_FOUND
    } else if lower.contains("being used by another process")
        || lower.contains("locked")
        || lower.contains("text file busy")
        || lower.contains("the process cannot access the file")
        || lower.contains("resource temporarily unavailable")
    {
        StatusCode::LOCKED
    } else if lower.contains("access is denied")
        || lower.contains("permission denied")
        || lower.contains("read-only file system")
        || lower.contains("write-protected")
        || lower.contains("path traversal denied")
    {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// Sanitizes a filename to only contain safe ASCII characters, replacing unsafe characters with `_`.
/// Falls back to `"file"` if the result contains only placeholder/separator characters.
pub fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.chars().all(|c| c == '_' || c == '.' || c == ' ') {
        "file".to_string()
    } else {
        sanitized
    }
}

/// Builds an RFC 5987 / RFC 6266 compliant `Content-Disposition` header string.
/// Provides an ASCII fallback `filename="..."` and a UTF-8 encoded `filename*=UTF-8''...`.
pub fn content_disposition(download: bool, filename: &str) -> String {
    let disposition_type = if download { "attachment" } else { "inline" };
    let ascii_clean = sanitize_filename(filename);
    let encoded_filename = urlencoding::encode(filename);

    format!("{disposition_type}; filename=\"{ascii_clean}\"; filename*=UTF-8''{encoded_filename}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_protocol_prefix() {
        // Unix format
        assert_eq!(
            strip_protocol_prefix("rclone://remote/path/file.txt", "rclone"),
            "remote/path/file.txt"
        );
        // Windows WebView2 format
        assert_eq!(
            strip_protocol_prefix("rclone://localhost/remote/path/file.txt", "rclone"),
            "/remote/path/file.txt"
        );
        // HTTP fallback format
        assert_eq!(
            strip_protocol_prefix("http://rclone.localhost/remote/path/file.txt", "rclone"),
            "/remote/path/file.txt"
        );
        // HTTPS fallback format
        assert_eq!(
            strip_protocol_prefix("https://rclone.localhost/remote/path/file.txt", "rclone"),
            "/remote/path/file.txt"
        );
        // Local asset retains leading slash
        assert_eq!(
            strip_protocol_prefix("local-asset://localhost/home/user/music.mp3", "local-asset"),
            "/home/user/music.mp3"
        );
        assert_eq!(
            strip_protocol_prefix("local-asset:///home/user/music.mp3", "local-asset"),
            "/home/user/music.mp3"
        );
        assert_eq!(
            strip_protocol_prefix(
                "http://local-asset.localhost/home/user/music.mp3",
                "local-asset"
            ),
            "/home/user/music.mp3"
        );
        // Non-matching URI
        assert_eq!(
            strip_protocol_prefix("file:///home/user/test.txt", "rclone"),
            "file:///home/user/test.txt"
        );
    }

    #[test]
    fn test_strip_protocol_prefix_trimmed() {
        assert_eq!(
            strip_protocol_prefix_trimmed("rclone://localhost/my-remote/file.txt", "rclone"),
            "my-remote/file.txt"
        );
        assert_eq!(
            strip_protocol_prefix_trimmed(
                "http://audio-cover.localhost/local/foo.mp3",
                "audio-cover"
            ),
            "local/foo.mp3"
        );
        assert_eq!(
            strip_protocol_prefix_trimmed(
                "audio-cover://localhost/remote/my-remote/bar.mp3",
                "audio-cover"
            ),
            "remote/my-remote/bar.mp3"
        );
    }

    #[test]
    fn test_url_decode() {
        assert_eq!(url_decode("hello%20world"), "hello world");
        assert_eq!(url_decode("simple_path/file.txt"), "simple_path/file.txt");
        assert_eq!(url_decode("invalid%ZZ"), "invalid%ZZ");
    }

    #[test]
    fn test_decode_remote_name() {
        assert_eq!(decode_remote_name("my-drive"), "my-drive:");
        assert_eq!(decode_remote_name("my-drive:"), "my-drive:");
        assert_eq!(decode_remote_name("remote%20space"), "remote space:");
    }

    #[test]
    fn test_normalize_asset_path() {
        // Multi-slash normalization
        assert_eq!(
            normalize_asset_path("//sdcard/music/song.mp3".to_string()),
            "/sdcard/music/song.mp3"
        );
        assert_eq!(
            normalize_asset_path("///var/log/syslog".to_string()),
            "/var/log/syslog"
        );
        // Windows drive letter prefix
        assert_eq!(
            normalize_asset_path("/C:/Users/test/music.mp3".to_string()),
            "C:/Users/test/music.mp3"
        );
        assert_eq!(
            normalize_asset_path("/D:/folder/file.dat".to_string()),
            "D:/folder/file.dat"
        );
        // Standard Unix path untouched
        assert_eq!(
            normalize_asset_path("/home/user/file.txt".to_string()),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn test_parse_byte_range() {
        assert_eq!(parse_byte_range("bytes=0-1024"), Some((0, Some(1024))));
        assert_eq!(parse_byte_range("bytes=500-"), Some((500, None)));
        assert_eq!(parse_byte_range("bytes=100-200"), Some((100, Some(200))));
        assert_eq!(parse_byte_range("invalid"), None);
        assert_eq!(parse_byte_range("bytes="), None);
        assert_eq!(parse_byte_range("bytes=-100"), None);
    }

    #[test]
    fn test_classify_error_status() {
        assert_eq!(
            classify_error_status("file not found"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            classify_error_status("Directory not found on remote"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            classify_error_status("object not found"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            classify_error_status("file is being used by another process"),
            StatusCode::LOCKED
        );
        assert_eq!(classify_error_status("database locked"), StatusCode::LOCKED);
        assert_eq!(classify_error_status("text file busy"), StatusCode::LOCKED);
        assert_eq!(
            classify_error_status("resource temporarily unavailable"),
            StatusCode::LOCKED
        );
        assert_eq!(
            classify_error_status("Access is denied"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            classify_error_status("permission denied"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            classify_error_status("read-only file system"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            classify_error_status("write-protected"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            classify_error_status("Path traversal denied"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            classify_error_status("unknown network failure"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(
            sanitize_filename("valid-name_123.txt"),
            "valid-name_123.txt"
        );
        assert_eq!(
            sanitize_filename("file with spaces.mp3"),
            "file with spaces.mp3"
        );
        assert_eq!(
            sanitize_filename("file/with/slashes.txt"),
            "file_with_slashes.txt"
        );
        assert_eq!(sanitize_filename("../traversal.txt"), ".._traversal.txt");
        assert_eq!(sanitize_filename("türkçe_şubat.pdf"), "t_rk_e__ubat.pdf");
        assert_eq!(sanitize_filename("???"), "file");
        assert_eq!(sanitize_filename(""), "file");
    }

    #[test]
    fn test_content_disposition() {
        let inline = content_disposition(false, "song.mp3");
        assert_eq!(
            inline,
            "inline; filename=\"song.mp3\"; filename*=UTF-8''song.mp3"
        );

        let download = content_disposition(true, "song.mp3");
        assert_eq!(
            download,
            "attachment; filename=\"song.mp3\"; filename*=UTF-8''song.mp3"
        );

        let unicode = content_disposition(false, "müzik şubat.mp3");
        assert!(unicode.contains("filename=\"m_zik _ubat.mp3\""));
        assert!(unicode.contains("filename*=UTF-8''m%C3%BCzik%20%C5%9Fubat.mp3"));
    }
}
