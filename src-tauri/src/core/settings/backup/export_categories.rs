//! Export categories command
//!
//! Exposes rcman's dynamic export categories to the frontend.

use tauri::State;

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
pub fn get_export_categories(
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
) -> Vec<ExportCategoryResponse> {
    manager
        .get_export_categories()
        .into_iter()
        .map(|cat| ExportCategoryResponse {
            id: cat.id,
            name: cat.name,
            category_type: format!("{:?}", cat.category_type).to_lowercase(),
            optional: cat.optional,
            description: cat.description,
        })
        .collect()
}
