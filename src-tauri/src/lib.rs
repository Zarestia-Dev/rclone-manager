use api::{
    create_remote, delete_remote, get_all_remote_configs, get_mount_options, get_mount_types, get_mounted_remotes, get_remote_config, get_remote_config_fields, get_saved_mount_configs, save_mount_config, update_remote
};
use api::{get_remotes, list_mounts, mount_remote, unmount_remote};
use config::open_in_files;
use disk_helper::get_disk_usage;
use mount::{add_mount, get_mount_configs, remove_mount};
use rclone_api::{get_remote_types, RcloneState};
use reqwest::Client;
use tray::setup_tray;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{Manager, Theme, WebviewUrl, WindowEvent};
use tauri::WebviewWindowBuilder;
use tauri::Window;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_http::reqwest;
use tauri_plugin_os::platform;
use zip::ZipArchive;
pub mod api;
pub mod config;
pub mod mount;
pub mod rclone_api;
pub mod tracker;
pub  mod disk_helper;
mod tray;

#[tauri::command]
async fn check_rclone_installed() -> bool {
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

#[tauri::command]
async fn provision_rclone(window: Window) -> Result<String, String> {
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

#[tauri::command]
async fn get_folder_location(window: Window) -> Option<String> {
    window
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string().to_string())
}

#[tauri::command]
fn set_theme(theme: String, window: tauri::Window) {
    let theme = match theme.as_str() {
        "dark" => Theme::Dark,
        _ => Theme::Light,
    };
    window.set_theme(Some(theme)).expect("Failed to set theme");
}

fn lower_webview_priority() {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd")
            .args(&["/C", "wmic process where name='WebView2.exe' CALL setpriority 64"])
            .output();
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("renice")
            .args(&["-n", "19", "-p", &std::process::id().to_string()])
            .output();

        print!("Lowered priority");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
    // .on_window_event(|window, event| match event {
    //     tauri::WindowEvent::CloseRequested { api, .. } => {
    //         api.prevent_close();
    //         if let Some(win) = window.app_handle().get_webview_window("main") {
    //             let _ = win.hide();
    //         }
    //     }
    //     _ => {}
    // }) // ✅ Prevent window close and hide instead

    // .on_window_event(|window, event| match event {
    //     WindowEvent::CloseRequested { api, .. } => {
    //         api.prevent_close();
    //         api.prevent_close();
    //         if let Some(win) = window.app_handle().get_webview_window("main") {
    //             let _ = win.hide();
    //             let _ = win.eval("document.body.innerHTML = '';"); // ✅ Clear UI content to free memory
    //         }
    //     }
    //     WindowEvent::Focused(false) => {
    //         if let Some(win) = window.app_handle().get_webview_window("main") {
    //             let _ = win.eval("document.body.innerHTML = '';"); // ✅ Clear UI when unfocused
    //         }
    //     }
    //     WindowEvent::Focused(true) => {
    //         if let Some(win) = window.app_handle().get_webview_window("main") {
    //             let _ = win.eval("location.reload();"); // ✅ Reload UI when refocused
    //         }
    //     }
    //     _ => {}
    // }) // ✅ Clear UI content when window is hidden
    .on_window_event(|window, event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(win) = window.app_handle().get_webview_window("main") {
                let _ = win.hide();
                lower_webview_priority(); // ✅ Reduce WebView CPU usage
            }
        }
        WindowEvent::Focused(true) => {
            if let Some(win) = window.app_handle().get_webview_window("main") {
                let _ = win.show();
            }
        }
        _ => {}
    }) // ✅ Hide window on close and show on focus
        .manage(RcloneState {
            client: Client::new(),
        })
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                setup_tray(&app_handle).await.expect("Failed to setup tray");
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_theme,
            check_rclone_installed,
            provision_rclone,
            list_mounts,
            mount_remote,
            unmount_remote,
            get_remotes,
            get_remote_config,
            get_all_remote_configs,
            add_mount,
            get_mount_configs,
            remove_mount,
            get_remote_types,
            get_mount_types,
            get_mount_options,
            get_remote_config_fields,
            create_remote,
            update_remote,
            delete_remote,
            get_saved_mount_configs,
            save_mount_config,
            get_mounted_remotes,
            get_disk_usage,
            open_in_files,
            get_folder_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

