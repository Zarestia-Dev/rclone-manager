use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use reqwest::Client;
use std::io::Write;

#[cfg(target_os = "macos")]
fn needs_mount_plugin() -> bool {
    let has_fuse_t = PathBuf::from("/Library/Application Support/fuse-t").exists();
    let has_osx_fuse = PathBuf::from("/Library/Filesystems/macfuse.fs").exists();
    println!("MacOS: hasFuseT: {}, hasOsxFuse: {}", has_fuse_t, has_osx_fuse);
    !has_fuse_t && !has_osx_fuse
}

#[cfg(target_os = "windows")]
fn needs_mount_plugin() -> bool {
    let has_winfsp = PathBuf::from("C:\\Program Files\\WinFsp").exists()
        || PathBuf::from("C:\\Program Files (x86)\\WinFsp").exists();
    println!("Windows: hasWinFsp: {}", has_winfsp);
    !has_winfsp
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn needs_mount_plugin() -> bool {
    false // No additional plugin required for Linux
}

#[tauri::command]
async fn download_mount_plugin(app: AppHandle) -> Result<(), String> {

    let client = Client::new();
    let download_path = app.path().app_data_dir().unwrap_or(PathBuf::from("/tmp"));

    #[cfg(target_os = "macos")]
    {
        let url = "https://github.com/macos-fuse-t/fuse-t/releases/download/1.0.44/fuse-t-macos-installer-1.0.44.pkg";
        let local_file = download_path.join("fuse-t-installer.pkg");
        
        if let Err(e) = fetch_and_save(&client, url, &local_file).await {
            return Err(format!("Failed to download macOS plugin: {}", e));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let url = "https://github.com/winfsp/winfsp/releases/download/v2.0/winfsp-2.0.23075.msi";
        let local_file = download_path.join("winfsp-installer.msi");

        if let Err(e) = fetch_and_save(&client, url, &local_file).await {
            return Err(format!("Failed to download Windows plugin: {}", e));
        }
    }

    Ok(())
}

async fn fetch_and_save(client: &Client, url: &str, file_path: &PathBuf) -> Result<(), String> {
    let response = client.get(url).send().await.map_err(|e| format!("Request failed: {}", e))?;
    let bytes = response.bytes().await.map_err(|e| format!("Failed to read bytes: {}", e))?;

    let mut file = fs::File::create(file_path).map_err(|e| format!("File creation error: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("Failed to write file: {}", e))?;

    println!("Downloaded and saved at {:?}", file_path);
    Ok(())
}
