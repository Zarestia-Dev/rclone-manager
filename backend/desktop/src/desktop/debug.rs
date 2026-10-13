/// Open `WebView` developer tools
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) -> Result<String, String> {
    window.open_devtools();
    log::debug!("🔧 Opened DevTools for window: {}", window.label());
    Ok("DevTools opened".to_string())
}
