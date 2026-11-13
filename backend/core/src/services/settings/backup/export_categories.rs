//! Export categories command
//!
//! Exposes rcman's dynamic export categories to the frontend.

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;

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
pub async fn get_export_categories(app: AppHandle) -> Result<Vec<ExportCategoryResponse>, String> {
    let manager = app.state::<AppSettingsManager>();
    let categories = manager
        .get_export_categories()
        .into_iter()
        .map(|cat| ExportCategoryResponse {
            id: cat.id,
            name: cat.name,
            category_type: cat.category_type.as_str().to_string(),
            optional: cat.optional,
            description: cat.description,
        })
        .collect();
    Ok(categories)
}

#[cfg(test)]
mod tests {
    use rcman::backup::ExportCategoryType;

    #[test]
    fn category_types_match_the_names_the_frontend_expects() {
        assert_eq!(ExportCategoryType::Settings.as_str(), "settings");
        assert_eq!(ExportCategoryType::SubSettings.as_str(), "sub_settings");
        assert_eq!(ExportCategoryType::External.as_str(), "external");
    }
}
