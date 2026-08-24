//! Centralized Rclone error classifier and mapper.
//!
//! Categorizes raw Go, FUSE, OS, and Rclone CLI runtime error strings directly extracted from
//! the Rclone source code (`fs/`, `cmd/mount/`, `cmd/cmount/`, `cmd/mountlib/`, `cmd/serve/`, `vfs/`)
//! into structured `localized_error!(...)` JSON strings.

/// Categorizes a raw Rclone or OS error message into a structured localization key.
/// Returns `Some(json_error)` if a known pattern matches, or `None` otherwise.
#[must_use]
pub fn map_rclone_error(raw_error: &str) -> Option<String> {
    let trimmed = raw_error.trim();
    if trimmed.is_empty() {
        return None;
    }

    let raw_lower = trimmed.to_lowercase();

    // -------------------------------------------------------------------------
    // 1. Mount errors (Source: rclone/cmd/mountlib/, rclone/cmd/cmount/, rclone/cmd/mount/)
    // -------------------------------------------------------------------------

    // rclone/cmd/mountlib/check_linux.go: "directory already mounted, use --allow-non-empty to mount anyway"
    // rclone/cmd/cmount/mountpoint_windows.go: "mountpoint path already exists"
    // rclone/cmd/mountlib/utils.go: "mount point ... and directory to be mounted ... mustn't overlap"
    // rclone/fs/fs.go: "can't sync or move files on overlapping remotes"
    if raw_lower.contains("directory already mounted")
        || raw_lower.contains("already mounted, use --allow-non-empty")
        || raw_lower.contains("mountpoint path already exists")
        || raw_lower.contains("mustn't overlap")
        || raw_lower.contains("overlapping remotes")
        || raw_lower.contains("already mounted")
    {
        return Some(crate::localized_error!(
            "backendErrors.mount.directoryAlreadyMounted"
        ));
    }

    // rclone/cmd/mountlib/utils.go: "%q is not empty, use --allow-non-empty to mount anyway"
    // rclone/fs/fs.go: "directory not empty"
    if raw_lower.contains("is not empty, use --allow-non-empty")
        || raw_lower.contains("directory not empty")
        || raw_lower.contains("folder is not empty")
        || raw_lower.contains("folder not empty")
    {
        return Some(crate::localized_error!(
            "backendErrors.mount.directoryNotEmpty"
        ));
    }

    // rclone/cmd/cmount/mount.go: "cannot find winfsp" / "Install WinFsp from https://winfsp.dev/rel/"
    if raw_lower.contains("cannot find winfsp")
        || raw_lower.contains("winfsp is not installed")
        || raw_lower.contains("cannot find winfsp-fuse")
        || raw_lower.contains("winfsp.dll")
    {
        return Some(crate::localized_error!("backendErrors.mount.winfspMissing"));
    }

    // Linux FUSE errors (fusermount, fusermount3, /dev/fuse)
    if raw_lower.contains("fusermount3: not found")
        || raw_lower.contains("fusermount: not found")
        || raw_lower.contains("fuse: device not found")
        || raw_lower.contains("failed to exec mount: no such file or directory")
    {
        return Some(crate::localized_error!("backendErrors.mount.fuseMissing"));
    }

    // macOS FUSE errors (macfuse, fuse-t)
    if raw_lower.contains("macfuse")
        || raw_lower.contains("mount_macfuse: not found")
        || raw_lower.contains("fuse-t: not found")
    {
        return Some(crate::localized_error!(
            "backendErrors.mount.macfuseMissing"
        ));
    }

    // rclone/cmd/cmount/mountpoint_windows.go: "could not find unused drive letter"
    if (raw_lower.contains("drive letter") && raw_lower.contains("already in use"))
        || raw_lower.contains("could not find unused drive letter")
    {
        return Some(crate::localized_error!(
            "backendErrors.mount.driveLetterInUse"
        ));
    }

    // FUSE permission errors (rclone/fs/fs.go: "permission denied")
    if raw_lower.contains("cannot open /dev/fuse")
        || (raw_lower.contains("fuse") && raw_lower.contains("permission denied"))
    {
        return Some(crate::localized_error!(
            "backendErrors.mount.permissionDenied"
        ));
    }

    // -------------------------------------------------------------------------
    // 2. Serve / Network Bind errors (Source: rclone/cmd/serve/, rclone/lib/http/)
    // -------------------------------------------------------------------------

    // OS socket binding error: "listen tcp ...: bind: address already in use" (Unix)
    // "only one usage of each socket address (protocol/network address/port) is normally permitted" (Windows WSAEADDRINUSE)
    if raw_lower.contains("bind: address already in use")
        || raw_lower.contains("only one usage of each socket address")
        || raw_lower.contains("address already in use")
    {
        return Some(crate::localized_error!(
            "backendErrors.serve.addressAlreadyInUse"
        ));
    }

    // Privileged port error (< 1024 without root): "listen tcp :80: bind: permission denied"
    if (raw_lower.contains("listen tcp") && raw_lower.contains("permission denied"))
        || (raw_lower.contains("listen udp") && raw_lower.contains("permission denied"))
        || raw_lower.contains("bind: permission denied")
    {
        return Some(crate::localized_error!(
            "backendErrors.serve.privilegedPort"
        ));
    }

    // TLS / Certificate errors (rclone/lib/http/server.go: "can't listen on ...: tls config required")
    if raw_lower.contains("tls: bad certificate")
        || raw_lower.contains("tls: failed to parse")
        || raw_lower.contains("tls certificate")
        || raw_lower.contains("tls config required")
        || raw_lower.contains("invalid min-tls-version")
    {
        return Some(crate::localized_error!("backendErrors.serve.tlsError"));
    }

    // -------------------------------------------------------------------------
    // 3. Remote / Authentication / Network errors (Source: rclone/fs/, rclone/fs/fserrors/)
    // -------------------------------------------------------------------------

    // OAuth2 / Token expiration / 401 Unauthorized (Source: rclone/lib/oauthutil/oauthutil.go)
    if raw_lower.contains("oauth2: cannot fetch token")
        || raw_lower.contains("invalid_grant")
        || raw_lower.contains("token expired")
        || raw_lower.contains("token has been revoked")
        || raw_lower.contains("empty token found")
        || raw_lower.contains("config reconnect")
        || raw_lower.contains("refreshing token with")
        || raw_lower.contains("couldn't fetch token")
        || raw_lower.contains("failed to get token")
        || (raw_lower.contains("401") && raw_lower.contains("unauthorized"))
    {
        return Some(crate::localized_error!("backendErrors.remote.authExpired"));
    }

    // Quota / Rate limiting (Google Drive, OneDrive, S3, Dropbox rate limits)
    if raw_lower.contains("ratelimitexceeded")
        || raw_lower.contains("user rate limit exceeded")
        || raw_lower.contains("quota exceeded")
        || raw_lower.contains("out of quota")
        || raw_lower.contains("too many requests")
        || raw_lower.contains("429 too many requests")
        || raw_lower.contains("apiratelimitexceeded")
    {
        return Some(crate::localized_error!(
            "backendErrors.remote.quotaExceeded"
        ));
    }

    // Network transport / connection errors (rclone/fs/fserrors/error.go: retriableErrorStrings)
    if raw_lower.contains("no such host")
        || raw_lower.contains("network is unreachable")
        || raw_lower.contains("connection reset by peer")
        || raw_lower.contains("i/o timeout")
        || raw_lower.contains("context deadline exceeded")
        || raw_lower.contains("connection refused")
        || raw_lower.contains("connectex:")
        || raw_lower.contains("use of closed network connection")
        || raw_lower.contains("transport connection broken")
        || raw_lower.contains("server closed idle connection")
        || raw_lower.contains("http2: server sent goaway")
    {
        return Some(crate::localized_error!("backendErrors.remote.networkError"));
    }

    // Object / Directory / Config not found (rclone/fs/fs.go: ErrorDirNotFound, ErrorObjectNotFound, ErrorNotFoundInConfigFile)
    if raw_lower.contains("directory not found")
        || raw_lower.contains("object not found")
        || raw_lower.contains("didn't find section in config file")
        || raw_lower.contains("config file not found")
        || raw_lower.contains("404 not found")
        || raw_lower.contains("item not found")
    {
        return Some(crate::localized_error!("backendErrors.remote.notFound"));
    }

    // -------------------------------------------------------------------------
    // 4. File / Filesystem / Disk errors (Source: rclone/fs/, rclone/vfs/)
    // -------------------------------------------------------------------------

    // Out of disk space (rclone/vfs/vfscache/item.go: "no space left on device")
    if raw_lower.contains("no space left on device")
        || raw_lower.contains("disk is full")
        || raw_lower.contains("there is not enough space on the disk")
    {
        return Some(crate::localized_error!("backendErrors.file.diskFull"));
    }

    // File lock / Concurrency issues (Windows ERROR_SHARING_VIOLATION / Unix ETXTBSY / EBUSY)
    if raw_lower.contains("text file busy")
        || raw_lower.contains("the process cannot access the file")
        || raw_lower.contains("file is locked")
        || raw_lower.contains("resource temporarily unavailable")
    {
        return Some(crate::localized_error!("backendErrors.file.fileLocked"));
    }

    // Read-only filesystem / write protection (rclone/fs/fs.go: ErrorImmutableModified)
    if raw_lower.contains("read-only file system")
        || raw_lower.contains("write-protected")
        || raw_lower.contains("immutable file modified")
    {
        return Some(crate::localized_error!("backendErrors.file.readOnly"));
    }

    // -------------------------------------------------------------------------
    // 5. Checksum & Corruption (Source: rclone/fs/operations/check.go)
    // -------------------------------------------------------------------------

    // Checksum & Corruption errors: "corrupted on transfer", "checksum mismatch", "files differ", "contents differ"
    if raw_lower.contains("corrupted on transfer")
        || raw_lower.contains("checksum mismatch")
        || raw_lower.contains("differ on transfer")
        || raw_lower.contains("files differ")
        || raw_lower.contains("contents differ")
    {
        return Some(crate::localized_error!(
            "backendErrors.job.corruptedTransfer"
        ));
    }

    None
}

/// Maps a job execution error to a localized message, falling back to `backendErrors.job.executionFailed`.
#[must_use]
pub fn map_or_wrap_job_error(raw_error: &str) -> String {
    let trimmed = raw_error.trim();
    if trimmed.is_empty() {
        return crate::localized_error!("backendErrors.job.executionFailed", "error" => "");
    }

    if let Some(mapped) = map_rclone_error(trimmed) {
        mapped
    } else {
        crate::localized_error!("backendErrors.job.executionFailed", "error" => trimmed)
    }
}

/// Maps a serve execution error to a localized message, falling back to `backendErrors.serve.startFailed`.
#[must_use]
pub fn map_or_wrap_serve_error(raw_error: &str) -> String {
    let trimmed = raw_error.trim();
    if trimmed.is_empty() {
        return crate::localized_error!("backendErrors.serve.startFailed", "error" => "");
    }

    if let Some(mapped) = map_rclone_error(trimmed) {
        mapped
    } else {
        crate::localized_error!("backendErrors.serve.startFailed", "error" => trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mount_directory_already_mounted_linux() {
        let err = "failed to mount FUSE fs: directory already mounted, use --allow-non-empty to mount anyway: /home/user/mount";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.mount.directoryAlreadyMounted".to_string())
        );
    }

    #[test]
    fn test_mount_windows_path_already_exists() {
        let err = "mountpoint path already exists: C:\\mount";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.mount.directoryAlreadyMounted".to_string())
        );
    }

    #[test]
    fn test_mount_overlapping_paths() {
        let err = "mount point \"/mnt/a\" (\"/mnt/a\") and directory to be mounted \"/mnt/a/b\" (\"/mnt/a/b\") mustn't overlap";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.mount.directoryAlreadyMounted".to_string())
        );
    }

    #[test]
    fn test_mount_directory_not_empty() {
        let err = "\"/mnt/data\" is not empty, use --allow-non-empty to mount anyway";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.mount.directoryNotEmpty".to_string())
        );
    }

    #[test]
    fn test_mount_winfsp_missing() {
        let err = "cgofuse: cannot find winfsp";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.mount.winfspMissing".to_string())
        );
    }

    #[test]
    fn test_mount_fuse_missing() {
        let err = "fusermount3: not found";
        let mapped = map_rclone_error(err);
        assert_eq!(mapped, Some("backendErrors.mount.fuseMissing".to_string()));
    }

    #[test]
    fn test_mount_drive_letter_exhausted() {
        let err = "could not find unused drive letter";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.mount.driveLetterInUse".to_string())
        );
    }

    #[test]
    fn test_serve_address_already_in_use() {
        let err = "rclone RPC failed: serve/start -> HTTP 500: could not start serve \"http\": failed to init server: listen tcp 127.0.0.1:8080: bind: address already in use";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.serve.addressAlreadyInUse".to_string())
        );
    }

    #[test]
    fn test_remote_section_not_found() {
        let err = "didn't find section in config file";
        let mapped = map_rclone_error(err);
        assert_eq!(mapped, Some("backendErrors.remote.notFound".to_string()));
    }

    #[test]
    fn test_remote_auth_expired() {
        let err = "Failed to create file system: oauth2: cannot fetch token: 400 Bad Request";
        let mapped = map_rclone_error(err);
        assert_eq!(mapped, Some("backendErrors.remote.authExpired".to_string()));
    }

    #[test]
    fn test_remote_empty_token_reconnect() {
        let err = "failed to configure google photos: empty token found - please run \"rclone config reconnect googlephotos:\"";
        let mapped = map_rclone_error(err);
        assert_eq!(mapped, Some("backendErrors.remote.authExpired".to_string()));
    }

    #[test]
    fn test_remote_quota_exceeded() {
        let err = "HTTP 403 Rate Limit Exceeded: User rate limit exceeded";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.remote.quotaExceeded".to_string())
        );
    }

    #[test]
    fn test_disk_full() {
        let err = "write /tmp/file: no space left on device";
        let mapped = map_rclone_error(err);
        assert_eq!(mapped, Some("backendErrors.file.diskFull".to_string()));
    }

    #[test]
    fn test_checksum_and_corruption() {
        let err = "corrupted on transfer: MD5 differ";
        let mapped = map_rclone_error(err);
        assert_eq!(
            mapped,
            Some("backendErrors.job.corruptedTransfer".to_string())
        );
    }

    #[test]
    fn test_fallback_unmapped_error() {
        let err = "some totally obscure and unique error";
        assert_eq!(map_rclone_error(err), None);

        let wrapped = map_or_wrap_job_error(err);
        let parsed: serde_json::Value = serde_json::from_str(&wrapped).unwrap();
        assert_eq!(parsed["key"], "backendErrors.job.executionFailed");
        assert_eq!(parsed["params"]["error"], err);
    }
}
