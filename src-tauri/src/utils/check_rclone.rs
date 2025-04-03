use std::{fs, path::{Path, PathBuf}, process::Command};

use log::{debug, info};
use serde_json::{json, Value};
use tauri::{command, AppHandle, Manager};
use tauri_plugin_os::platform;
use zip::ZipArchive;

#[command]
pub async fn check_rclone_installed() -> bool {
    Command::new("rclone")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn safe_copy_rclone(rclone_binary_path: &Path, final_install_dir: &Path, binary_name: &str) -> Result<(), String> {
    let target_path = final_install_dir.join(binary_name);

    // If file exists, check if it's corrupt (not executable or 0 bytes)
    if target_path.exists() {
        if fs::metadata(&target_path).map(|m| m.len() == 0).unwrap_or(true) {
            info!("⚠️ Found broken Rclone binary. Deleting...");
            fs::remove_file(&target_path).map_err(|e| format!("Failed to delete broken Rclone binary: {}", e))?;
        }
    }

    // Copy the file
    fs::copy(rclone_binary_path, &target_path)
        .map_err(|e| format!("Failed to copy Rclone binary: {}", e))?;

    info!("✅ Successfully copied Rclone binary to {:?}", target_path);
    Ok(())
}

fn get_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "amd64".to_string(),
        "aarch64" => "arm64".to_string(),
        "i686" => "386".to_string(),
        _ => "unknown".to_string(),
    }
}

fn save_rclone_path(app_handle: &AppHandle, rclone_path: &str) -> Result<(), String> {
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

    settings["core_options"]["rclone_path"] = Value::String(rclone_path.to_string());

    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .map_err(|e| format!("Failed to save settings: {}", e))?;

    println!("✅ Rclone path saved: {}", rclone_path);
    Ok(())
}

#[command]
pub async fn provision_rclone(
    app_handle: tauri::AppHandle,
    path: Option<String>,
) -> Result<String, String> {
    let os = platform();
    let arch = get_arch();

    let install_path = match path {
        Some(custom_path) => PathBuf::from(custom_path),
        None => app_handle
            .path()
            .app_data_dir()
            .expect("Failed to get app data directory"),
    };

    // First, check if Rclone is already installed in the system
    if check_rclone_installed().await {
        save_rclone_path(&app_handle, "system")?;
        return Ok("Rclone already installed system-wide.".to_string());
    }

    let os_name = match os.as_ref() {
        "macos" => "osx",
        "linux" => "linux",
        "windows" => "windows",
        _ => return Err("Unsupported operating system.".to_string()),
    };

    // Fetch the latest Rclone version
    let version_url = "https://downloads.rclone.org/version.txt";
    let version_txt = reqwest::get(version_url)
        .await
        .map_err(|e| format!("Failed to fetch Rclone version: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read version text: {}", e))?;

    // Extract the correct version (removing "rclone v")
    let version = version_txt.trim().replace("rclone v", ""); // Removes "rclone v" prefix

    // Construct the correct download URL
    let download_url = format!(
        "https://downloads.rclone.org/v{}/rclone-v{}-{}-{}.zip",
        version, version, os_name, arch
    );

    debug!("Rclone download URL: {}", download_url);

    let temp_dir = std::env::temp_dir().join("rclone_temp");
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).map_err(|e| format!("Failed to clean temp dir: {}", e))?;
    }
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    debug!("Temporary directory created at: {:?}", temp_dir);

    let zip_path = temp_dir.join(format!("rclone-v{}-{}-{}.zip", version, os_name, arch));

    let mut retries = 3;
    let mut response = Vec::new();

    while retries > 0 {
        match reqwest::get(&download_url).await {
            Ok(resp) => {
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Failed to read Rclone zip: {}", e))?;
                response = bytes.to_vec();
                debug!("Rclone ZIP downloaded successfully.");
                break;
            }
            Err(e) => {
                retries -= 1;
                if retries == 0 {
                    debug!("Failed to download Rclone after 3 retries: {}", e);
                    return Err(format!("Failed to download Rclone after retries: {}", e));
                }
            }
        }
    }
    

    if response.is_empty() {
        return Err("Downloaded file is empty.".to_string());
    }

    fs::write(&zip_path, &response).map_err(|e| format!("Failed to save ZIP file: {}", e))?;

    debug!("Rclone ZIP downloaded to: {:?}", zip_path);

    let extract_path = temp_dir.join("rclone");
    fs::create_dir_all(&extract_path)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    debug!("Extracting Rclone ZIP to: {:?}", extract_path);

    // Extract ZIP using Rust's zip crate
    let zip_file =
        fs::File::open(&zip_path).map_err(|e| format!("Failed to open ZIP file: {}", e))?;
    let mut archive =
        ZipArchive::new(zip_file).map_err(|e| format!("Failed to extract ZIP: {}", e))?;
    archive
        .extract(&extract_path)
        .map_err(|e| format!("Failed to unzip Rclone: {}", e))?;

    debug!("Rclone ZIP extracted successfully.");

    let binary_name = if os == "windows" {
        "rclone.exe"
    } else {
        "rclone"
    };

    let rclone_binary_path = extract_path
        .join(format!("rclone-v{}-{}-{}", version, os_name, arch))
        .join(binary_name);

    if !rclone_binary_path.exists() {
        return Err("Rclone binary not found in extracted files.".to_string());
    }

    let final_install_dir = PathBuf::from(install_path);

    debug!("Final install directory: {}", final_install_dir.join(binary_name).display());

    safe_copy_rclone(&rclone_binary_path, &final_install_dir, binary_name)?;
    debug!("Rclone binary copied to: {}", final_install_dir.join(binary_name).display());

    save_rclone_path(&app_handle, &final_install_dir.to_str().unwrap())?;
    debug!("Rclone path saved to settings: {}", final_install_dir.display());

    Ok(format!(
        "Rclone successfully installed in {}",
        final_install_dir.display()
    ))
}
