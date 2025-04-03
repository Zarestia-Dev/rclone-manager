use std::{fs, path::PathBuf, process::Command};

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

    let settings_path = config_dir.join("settings.json");

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

    // println!("Downloading Rclone from: {}", download_url);

    let temp_dir = std::env::temp_dir().join("rclone_temp");
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).map_err(|e| format!("Failed to clean temp dir: {}", e))?;
    }
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

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
                break;
            }
            Err(e) => {
                retries -= 1;
                if retries == 0 {
                    return Err(format!("Failed to download Rclone after retries: {}", e));
                }
            }
        }
    }

    if response.is_empty() {
        return Err("Downloaded file is empty.".to_string());
    }

    fs::write(&zip_path, &response).map_err(|e| format!("Failed to save ZIP file: {}", e))?;

    // let metadata = fs::metadata(&zip_path).map_err(|e| format!("Failed to get metadata: {}", e))?;
    // println!("ZIP file size: {} bytes", metadata.len());

    let extract_path = temp_dir.join("rclone");
    fs::create_dir_all(&extract_path)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    // Extract ZIP using Rust's zip crate
    let zip_file =
        fs::File::open(&zip_path).map_err(|e| format!("Failed to open ZIP file: {}", e))?;
    let mut archive =
        ZipArchive::new(zip_file).map_err(|e| format!("Failed to extract ZIP: {}", e))?;
    archive
        .extract(&extract_path)
        .map_err(|e| format!("Failed to unzip Rclone: {}", e))?;

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

    let final_install_dir = install_path.to_str().unwrap().to_string();

    fs::copy(&rclone_binary_path, &final_install_dir)
        .map_err(|e| format!("Failed to copy Rclone binary: {}", e))?;

    save_rclone_path(&app_handle, &final_install_dir)?;

    Ok(format!(
        "Rclone successfully installed in {}",
        final_install_dir
    ))
}
