use log::{debug, info};
use reqwest::get;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::{fs, path::Path};

pub fn get_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "amd64".into(),
        "aarch64" => "arm64".into(),
        "i686" => "386".into(),
        _ => "unknown".into(),
    }
}

/// Helper to build a proper rclone path from remote and relative path.
/// Handles both rclone remotes (e.g., "remote:") and local paths.
pub fn build_full_path(remote: &str, path: &str) -> String {
    if path.is_empty() {
        remote.to_string()
    } else if remote.ends_with(':') {
        format!("{}/{}", remote, path.trim_start_matches('/'))
    } else {
        // Local path - ensure we join with a slash
        format!(
            "{}/{}",
            remote.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }
}

pub fn safe_copy_rclone(from: &Path, to: &Path, binary_name: &str) -> Result<(), String> {
    // Create directory if it doesn't exist
    fs::create_dir_all(to).map_err(|e| format!("Failed to create directory: {e}"))?;

    let target = to.join(binary_name);

    if target.exists() && fs::metadata(&target).map(|m| m.len() == 0).unwrap_or(true) {
        info!("⚠️ Found broken Rclone binary. Deleting...");
        fs::remove_file(&target).map_err(|e| e.to_string())?;
    }

    fs::copy(from, &target).map_err(|e| e.to_string())?;
    info!("✅ Copied Rclone binary to {target:?}");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut perms = fs::metadata(&target)
            .map_err(|e| format!("Failed to read metadata: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&target, perms)
            .map_err(|e| format!("Failed to set permissions: {e}"))?;

        info!("🔒 Executable permissions set for {target:?}");

        let perms = fs::metadata(&target)
            .map_err(|e| format!("Failed to verify permissions: {e}"))?
            .permissions();

        debug!("Final permissions: {:o}", perms.mode());

        File::open(&target)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("Failed to sync file to disk: {e}"))?;
    }

    Ok(())
}

pub fn compute_sha256<P: AsRef<Path>>(path: P) -> Result<String, String> {
    let mut file = File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("Hashing failed: {e}"))?;
    let result = hasher.finalize();
    Ok(format!("{result:x}"))
}

/// Verifies the downloaded rclone zip against its official SHA256 hash.
pub async fn verify_rclone_sha256(
    zip_path: &Path,
    version: &str,
    platform_zip_name: &str,
) -> Result<(), String> {
    let sha_url = format!("https://downloads.rclone.org/{version}/SHA256SUMS");

    debug!("Fetching SHA256SUMS from: {sha_url}");
    debug!("Verifying file: {platform_zip_name}");
    debug!("Using zip path: {}", zip_path.display());
    debug!("Using version: {version}");
    debug!("Using platform zip name: {platform_zip_name}");
    debug!("Using SHA256SUMS URL: {sha_url}");

    let response = get(&sha_url)
        .await
        .map_err(|e| format!("Failed to fetch SHA256SUMS: {e}"))?;
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read SHA256SUMS: {e}"))?;

    let wanted_hash = text
        .lines()
        .find(|line| line.ends_with(platform_zip_name))
        .and_then(|line| line.split_whitespace().next())
        .ok_or_else(|| format!("Could not find hash for file: {platform_zip_name}"))?;

    let computed_hash = compute_sha256(zip_path.join(platform_zip_name))?;

    if wanted_hash != computed_hash {
        Err(format!(
            "SHA256 mismatch!\nExpected: {wanted_hash}\nActual:   {computed_hash}"
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_get_arch_returns_known_value() {
        let arch = get_arch();
        // Should return one of the known architecture mappings
        assert!(
            ["amd64", "arm64", "386", "unknown"].contains(&arch.as_str()),
            "Unexpected arch: {}",
            arch
        );
    }

    #[test]
    fn test_get_arch_is_consistent() {
        // Multiple calls should return the same value
        let arch1 = get_arch();
        let arch2 = get_arch();
        assert_eq!(arch1, arch2);
    }

    #[test]
    fn test_compute_sha256_known_content() {
        // Create a temp file with known content
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("sha256_test_file.txt");

        let content = b"Hello, World!";
        {
            let mut file = File::create(&test_file).expect("Failed to create test file");
            file.write_all(content)
                .expect("Failed to write test content");
        }

        let hash = compute_sha256(&test_file).expect("Failed to compute hash");

        // Known SHA256 of "Hello, World!"
        let expected = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f";
        assert_eq!(hash, expected);

        // Cleanup
        std::fs::remove_file(&test_file).ok();
    }

    #[test]
    fn test_compute_sha256_nonexistent_file() {
        let result = compute_sha256("/nonexistent/path/to/file.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to open file"));
    }

    #[test]
    fn test_compute_sha256_empty_file() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("sha256_empty_file.txt");

        {
            File::create(&test_file).expect("Failed to create test file");
        }

        let hash = compute_sha256(&test_file).expect("Failed to compute hash");

        // Known SHA256 of empty content
        let expected = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(hash, expected);

        // Cleanup
        std::fs::remove_file(&test_file).ok();
    }
}
