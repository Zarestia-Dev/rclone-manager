//! Export categories command
//!
//! Exposes rcman's dynamic export categories to the frontend.

use crate::core::settings::AppSettingsManager;
use tauri::{AppHandle, Manager};

/// Response type for export categories
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCategoryResponse {
    pub id: String,
    pub name: String,
    pub category_type: String,
    pub optional: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Get available export categories from rcman
#[tauri::command]
pub async fn get_export_categories(app: AppHandle) -> Result<Vec<ExportCategoryResponse>, String> {
    let manager = app.state::<AppSettingsManager>();
    let categories = manager
        .get_export_categories()
        .into_iter()
        .map(|cat| ExportCategoryResponse {
            id: cat.id,
            name: cat.name,
            category_type: format!("{:?}", cat.category_type).to_lowercase(),
            optional: cat.optional,
            description: cat.description,
        })
        .collect();
    Ok(categories)
}
