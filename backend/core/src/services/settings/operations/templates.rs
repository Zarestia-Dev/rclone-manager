//! User Preset Templates persistence commands using rcman sub-settings

use std::collections::HashMap;

use crate::context::AppHandle;
use crate::services::settings::with_sub_settings;
use crate::utils::constants::SUB_TEMPLATES;
use log::info;

/// List all saved user preset templates as a dictionary map (id -> payload)
pub async fn list_user_templates(
    app: AppHandle,
) -> Result<HashMap<String, serde_json::Value>, String> {
    with_sub_settings(
        &app,
        SUB_TEMPLATES,
        "backendErrors.settings.loadFailed",
        |templates| templates.get_all_values(),
    )
    .await
}

/// Create or replace a template; `set` is an upsert, so saving and updating are one operation.
async fn store_template(
    app: &AppHandle,
    id: &str,
    template: serde_json::Value,
) -> Result<(), String> {
    let id = id.to_owned();
    with_sub_settings(
        app,
        SUB_TEMPLATES,
        "backendErrors.settings.saveFailed",
        move |templates| templates.set(&id, &template),
    )
    .await
}

/// Save a new user preset template by id and payload
pub async fn save_user_template(
    app: AppHandle,
    id: String,
    template: serde_json::Value,
) -> Result<(), String> {
    store_template(&app, &id, template).await?;
    info!("User template {id} saved via rcman.");
    Ok(())
}

/// Update an existing user preset template by id and payload
pub async fn update_user_template(
    app: AppHandle,
    id: String,
    template: serde_json::Value,
) -> Result<(), String> {
    store_template(&app, &id, template).await?;
    info!("User template {id} updated via rcman.");
    Ok(())
}

/// Delete a user preset template by id
pub async fn delete_user_template(app: AppHandle, id: String) -> Result<(), String> {
    let deleted = id.clone();
    with_sub_settings(
        &app,
        SUB_TEMPLATES,
        "backendErrors.settings.deleteEntryFailed",
        move |templates| templates.delete(&deleted),
    )
    .await?;
    info!("User template {id} deleted via rcman.");
    Ok(())
}
