use tauri::{command, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[command]
pub async fn get_folder_location(window: Window) -> Option<String> {
    window
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string().to_string())
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
