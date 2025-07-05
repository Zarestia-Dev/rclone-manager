use log::{debug, error};
use tauri::{command, AppHandle, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[command]
pub async fn get_folder_location(
    app: AppHandle,
    require_empty: bool,
) -> Result<Option<String>, String> {
    debug!("Opening folder picker dialog");

    let folder = match app
        .dialog()
        .file()
        .set_title("Select Folder")
        .blocking_pick_folder()
        .map(|p| p.to_string())
    {
        Some(path) if path.is_empty() => {
            debug!("User selected empty path");
            return Ok(None);
        }
        Some(path) => path,
        _ => {
            debug!("User cancelled folder selection");
            return Ok(None);
        }
    };

    #[cfg(target_os = "windows")]
    {
        // If the selected path is a drive root (e.g., D:\), prevent selection and show error

        use std::path::{Component, Path};
        let path = Path::new(&folder);
        if let Some(drive) = path.components().next() {
            if matches!(drive, Component::Prefix(_)) && path.parent().is_none() {
                debug!("Selected path is a drive root, which is not allowed for mounting");
                return Err("Cannot select a drive root (e.g., D:\\) as a mount point. Please select or create a subfolder.".into());
            }
        }
    }

    if require_empty {
        debug!("Checking if folder is empty: {}", folder);
        let path = std::path::Path::new(&folder);

        // Check if folder exists and is empty
        match tokio::fs::read_dir(path).await {
            Ok(mut entries) => match entries.next_entry().await {
                Ok(Some(_)) => return Err("Selected folder is not empty".into()),
                Ok(_) => (), // Folder is empty
                Err(e) => {
                    error!("Error reading directory: {}", e);
                    return Err(format!("Error checking folder: {}", e));
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (), // Folder doesn't exist
            Err(e) => {
                error!("Error accessing folder: {}", e);
                return Err(format!("Error accessing folder: {}", e));
            }
        }

        // On Windows, clean up the empty folder if it exists
        #[cfg(target_os = "windows")]
        if path.exists() {
            debug!("Removing existing empty folder on Windows");
            if let Err(e) = tokio::fs::remove_dir_all(path).await {
                error!("Failed to remove folder: {}", e);
                return Err(format!("Failed to prepare folder: {}", e));
            }
        }
    }

    Ok(Some(folder))
}

#[command]
pub async fn open_in_files(
    app: tauri::AppHandle,
    path: std::path::PathBuf,
) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err("Invalid path: Path cannot be empty.".to_string());
    }

    if !path.exists() {
        return Err(format!("Path not exist: {}", path.display()));
    }

    let path_str = path
        .to_str()
        .ok_or_else(|| format!("Invalid path: {}", path.display()))?
        .to_string();
    match app.opener().open_path(path_str, None::<String>) {
        Ok(_) => Ok(format!("Opened file manager at {}", path.display())),
        Err(e) => Err(format!("Failed to open file manager: {}", e)),
    }
}

#[command]
pub async fn get_file_location(window: Window) -> Result<Option<String>, String> {
    debug!("Opening file picker dialog...");

    let file_location = window
        .dialog()
        .file()
        .blocking_pick_file()
        .map(|path| path.to_string());

    debug!("File location: {:?}", file_location);

    Ok(file_location)
}
