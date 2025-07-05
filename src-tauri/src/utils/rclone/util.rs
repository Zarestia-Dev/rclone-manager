use log::{debug, info};
use reqwest::get;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::{fs, path::Path};
use tauri::{AppHandle, Manager};

pub fn get_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "amd64".into(),
        "aarch64" => "arm64".into(),
        "i686" => "386".into(),
        _ => "unknown".into(),
    }
}
pub fn safe_copy_rclone(from: &Path, to: &Path, binary_name: &str) -> Result<(), String> {
    // Create directory if it doesn't exist
    fs::create_dir_all(to).map_err(|e| format!("Failed to create directory: {}", e))?;

    let target = to.join(binary_name);

    if target.exists() {
        if fs::metadata(&target).map(|m| m.len() == 0).unwrap_or(true) {
            info!("⚠️ Found broken Rclone binary. Deleting...");
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
    }

    fs::copy(from, &target).map_err(|e| e.to_string())?;
    info!("✅ Copied Rclone binary to {:?}", target);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut perms = fs::metadata(&target)
            .map_err(|e| format!("Failed to read metadata: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&target, perms)
            .map_err(|e| format!("Failed to set permissions: {}", e))?;

        info!("🔒 Executable permissions set for {:?}", target);

        let perms = fs::metadata(&target)
            .map_err(|e| format!("Failed to verify permissions: {}", e))?
            .permissions();

        debug!("Final permissions: {:o}", perms.mode());

        File::open(&target)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("Failed to sync file to disk: {}", e))?;
    }

    Ok(())
}

pub fn save_rclone_path(app_handle: &AppHandle, path: &str) -> Result<(), String> {
    let config_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to get app data directory");

    let settings_path = config_dir.join("core.json");

    let mut settings: Value = if let Ok(contents) = fs::read_to_string(&settings_path) {
        serde_json::from_str(&contents).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    settings["core_options"]["rclone_path"] = Value::String(path.to_string());

    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn compute_sha256<P: AsRef<Path>>(path: P) -> Result<String, String> {
    let mut file = File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("Hashing failed: {e}"))?;
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

/// Verifies the downloaded rclone zip against its official SHA256 hash.
pub async fn verify_rclone_sha256(
    zip_path: &Path,
    version: &str,
    platform_zip_name: &str,
) -> Result<(), String> {
    let sha_url = format!("https://downloads.rclone.org/v{}/SHA256SUMS", version);

    debug!("Fetching SHA256SUMS from: {}", sha_url);
    debug!("Verifying file: {}", platform_zip_name);
    debug!("Using zip path: {}", zip_path.display());
    debug!("Using version: {}", version);
    debug!("Using platform zip name: {}", platform_zip_name);
    debug!("Using SHA256SUMS URL: {}", sha_url);

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
            "SHA256 mismatch!\nExpected: {}\nActual:   {}",
            wanted_hash, computed_hash
        ))
    } else {
        Ok(())
    }
}
