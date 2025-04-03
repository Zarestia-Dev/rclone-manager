use log::{debug, error};
use tauri::{command, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[command]
pub async fn get_folder_location(window: Window, is_empty: bool) -> Result<Option<String>, String> {
    debug!("Opening folder picker dialog...");
    
    let folder_location = window
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string());

    debug!("Folder location: {:?}", folder_location);

    if is_empty {
        if let Some(ref folder) = folder_location {
            let is_empty = match tokio::fs::read_dir(folder).await {
                Ok(mut entries) => match entries.next_entry().await {
                    Ok(None) => true,
                    Ok(Some(_)) => false,
                    Err(err) => {
                        error!("Error reading directory entry: {:?}", err);
                        false
                    }
                },
                Err(err) => {
                    error!("Error checking directory: {:?}", err);
                    false
                }
            };

            if !is_empty {
                return Err("Selected folder is not empty.".to_string());
            }
        }
    }

    Ok(folder_location)
}


#[command]
pub async fn open_in_files(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if path.is_empty() {
        return Err("Invalid path: Path cannot be empty.".to_string());
    }

    match app.opener().open_path(path.clone(), None::<&str>) {
        Ok(_) => Ok(format!("Opened file manager at {}", path)),
        Err(e) => Err(format!("Failed to open file manager: {}", e)),
    }
}
