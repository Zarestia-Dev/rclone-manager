use tauri::Window;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn get_folder_location(window: Window) -> Option<String> {
    window
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string().to_string())
}