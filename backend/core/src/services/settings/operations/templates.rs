//! User Preset Templates persistence commands using rcman sub-settings

use std::collections::HashMap;

use crate::context::AppHandle;
use crate::rclone::commands::common::RclonePayloadBuilder;
use crate::rclone::commands::filesystem::TransferMode;
use crate::services::settings::with_sub_settings;
use crate::utils::constants::SUB_TEMPLATES;
use log::{info, warn};

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

/// The options of a file browser copy, move or upload, keyed as rclone takes them in a
/// request: flat option names, `_config` and `_filter`.
#[derive(Debug, Default)]
pub(crate) struct TransferOptions {
    pub options: serde_json::Map<String, serde_json::Value>,
    /// The name of the template they come from, shown on the job.
    pub template: Option<String>,
}

/// A template's copy or move options, its filters and its backend options, merged the
/// way a profile's are.
fn template_options(
    values: &serde_json::Value,
    mode: TransferMode,
) -> serde_json::Map<String, serde_json::Value> {
    let operation = match mode {
        TransferMode::Copy => "copy",
        TransferMode::Move => "move",
    };
    let block = |category: &str| -> Option<HashMap<String, serde_json::Value>> {
        values
            .get(category)
            .and_then(serde_json::Value::as_object)
            .map(|options| {
                options
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
    };
    let mut builder = RclonePayloadBuilder::from_rclone_config(
        values.get(operation).unwrap_or(&serde_json::Value::Null),
    );
    builder
        .with_filter_options(block("filter").as_ref())
        .with_backend_options(block("backend").as_ref());
    std::mem::take(builder.as_map_mut())
}

/// The options a file browser transfer runs with. `template` is the id the user chose
/// for this transfer, empty for none; without a choice the file browser's default
/// (`file_browser.transfer_template`) applies. A template that no longer exists is
/// skipped: the transfer runs without it.
pub(crate) async fn transfer_options(
    app: &AppHandle,
    template: Option<String>,
    mode: TransferMode,
) -> TransferOptions {
    let id = match template {
        Some(id) => id,
        None => app
            .state::<crate::services::settings::AppSettingsManager>()
            .get::<String>("file_browser.transfer_template")
            .unwrap_or_default(),
    };
    if id.is_empty() {
        return TransferOptions::default();
    }
    let template = match list_user_templates(app.clone()).await {
        Ok(mut templates) => templates.remove(&id),
        Err(error) => {
            warn!("Cannot read transfer template {id}: {error}");
            None
        }
    };
    let Some(template) = template else {
        warn!("Transfer template {id} no longer exists; transferring without it");
        return TransferOptions::default();
    };
    TransferOptions {
        options: template_options(
            template.get("values").unwrap_or(&serde_json::Value::Null),
            mode,
        ),
        template: template
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_template_becomes_flat_options_and_config_and_filter_blocks() {
        let values = json!({
            "copy": {"check_first": true, "--max-transfer": "1G"},
            "move": {"delete_empty_src_dirs": true},
            "filter": {"exclude": ["*.tmp"], "MinSize": "1k"},
            "backend": {"transfers": 8, "LowLevelRetries": 20, "BwLimit": ""},
            "sync": {"track_renames": true},
        });
        let copy = serde_json::Value::Object(template_options(&values, TransferMode::Copy));
        assert_eq!(
            copy,
            json!({
                "check_first": true,
                "max_transfer": "1G",
                "exclude": ["*.tmp"],
                "transfers": 8,
                "_filter": {"MinSize": "1k"},
                "_config": {"LowLevelRetries": 20},
            })
        );
        let moved = template_options(&values, TransferMode::Move);
        assert_eq!(moved["delete_empty_src_dirs"], true);
        assert!(!moved.contains_key("check_first"));
        assert!(template_options(&json!({}), TransferMode::Copy).is_empty());
        assert!(template_options(&serde_json::Value::Null, TransferMode::Copy).is_empty());
    }
}
