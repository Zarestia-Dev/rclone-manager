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

/// The snake_case name rcman serializes, which the frontend's `ExportCategory` type expects.
fn category_type_name(category_type: rcman::backup::ExportCategoryType) -> String {
    serde_json::to_value(category_type)
        .ok()
        .and_then(|name| name.as_str().map(str::to_owned))
        .unwrap_or_default()
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
            category_type: category_type_name(cat.category_type),
            optional: cat.optional,
            description: cat.description,
        })
        .collect();
    Ok(categories)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcman::backup::ExportCategoryType;

    #[test]
    fn category_types_match_the_names_the_frontend_expects() {
        assert_eq!(category_type_name(ExportCategoryType::Settings), "settings");
        assert_eq!(
            category_type_name(ExportCategoryType::SubSettings),
            "sub_settings"
        );
        assert_eq!(category_type_name(ExportCategoryType::External), "external");
    }
}
