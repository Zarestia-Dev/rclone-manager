use tauri::Theme;

/// Set the application theme
#[tauri::command]
pub async fn set_theme(theme: String, window: tauri::Window) -> Result<(), String> {
    let theme_enum = match theme.as_str() {
        "dark" => Theme::Dark,
        _ => Theme::Light,
    };

    if window.theme().unwrap_or(Theme::Light) != theme_enum {
        window
            .set_theme(Some(theme_enum))
            .map_err(|e| format!("Failed to set theme: {e}"))?;
    }

    Ok(())
}
