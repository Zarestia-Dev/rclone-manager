use std::{fs, path::PathBuf, process::Command};

use tauri::{command, Window};
use tauri_plugin_os::platform;
use zip::ZipArchive;

use super::file_helper::get_folder_location;

#[command]
pub async fn check_rclone_installed() -> bool {
    let output = Command::new("rclone").arg("--version").output();
    match output {
        Ok(output) if output.status.success() => true,
        _ => false,
    }
}

fn get_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "amd64".to_string(),
        "aarch64" => "arm64".to_string(),
        "i686" => "386".to_string(),
        _ => "unknown".to_string(),
    }
}

#[command]
pub async fn provision_rclone(window: Window) -> Result<String, String> {
    let os = platform();
    let arch = get_arch();

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

    // Ask user for installation location
    let folder_location = get_folder_location(window)
        .await
        .ok_or("No installation folder selected.".to_string())?;

    let install_path = PathBuf::from(folder_location).join(binary_name);

    fs::copy(&rclone_binary_path, &install_path)
        .map_err(|e| format!("Failed to copy Rclone binary: {}", e))?;

    Ok(format!(
        "Rclone successfully installed in {}",
        install_path.display()
    ))
}
