//! `RClone` Backend Settings Manager (using rcman sub-settings single-file mode)

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use log::{debug, info};
use serde_json::json;

use crate::rclone::engine::lifecycle::restart_for_config_change;

/// Sync version for use in initialization
pub fn load_backend_options_sync(manager: &AppSettingsManager) -> serde_json::Value {
    let sub = match manager.sub_settings(crate::utils::constants::SUB_BACKEND) {
        Ok(s) => s,
        Err(_) => return json!({}),
    };

    let all = sub.get_all_values().unwrap_or_default();
    json!(all)
}

/// Save a single `RClone` backend option (block.option format)
pub async fn save_rclone_backend_option(
    app: AppHandle,
    block: String,
    option: String,
    value: serde_json::Value,
) -> Result<(), String> {
    debug!("Saving RClone option: {block}.{option}");
    let manager = app.state::<AppSettingsManager>();

    let sub = manager
        .sub_settings(crate::utils::constants::SUB_BACKEND)
        .map_err(|e| format!("Failed to get backend sub-settings: {e}"))?;

    let mut block_value = sub.get_value(&block).unwrap_or_else(|_| json!({}));

    if !block_value.is_object() {
        block_value = json!({});
    }

    if let Some(obj) = block_value.as_object_mut() {
        obj.insert(option.clone(), value.clone());
    }

    sub.set(&block, &block_value)
        .map_err(|e| format!("Failed to save block '{block}': {e}"))?;

    info!("RClone option {block}.{option} saved: {value}");
    Ok(())
}

/// Reset `RClone` backend options to defaults (delete all) and restart engine
pub async fn reset_rclone_backend_options(app: AppHandle) -> Result<(), String> {
    debug!("Resetting RClone backend options");
    let manager = app.state::<AppSettingsManager>();

    let sub = manager
        .sub_settings(crate::utils::constants::SUB_BACKEND)
        .map_err(|e| format!("Failed to get backend sub-settings: {e}"))?;

    let blocks = sub.list().unwrap_or_default();
    for block in blocks {
        let _ = sub.delete(&block);
    }

    info!("RClone backend options file cleared");

    restart_for_config_change(&app, "backend_options_reset");

    info!("RClone engine restart initiated");
    Ok(())
}

/// Remove a single `RClone` backend option
pub async fn remove_rclone_backend_option(
    app: AppHandle,
    block: String,
    option: String,
) -> Result<(), String> {
    debug!("Removing RClone option: {block}.{option}");
    let manager = app.state::<AppSettingsManager>();

    let sub = manager
        .sub_settings(crate::utils::constants::SUB_BACKEND)
        .map_err(|e| format!("Failed to get backend sub-settings: {e}"))?;

    let mut block_value = match sub.get_value(&block) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };

    if !block_value.is_object() {
        return Ok(());
    }

    if let Some(obj) = block_value.as_object_mut() {
        obj.remove(&option);

        if obj.is_empty() {
            let _ = sub.delete(&block);
        } else {
            sub.set(&block, &block_value)
                .map_err(|e| format!("Failed to save block '{block}': {e}"))?;
        }
    }

    info!("RClone option {block}.{option} removed (reset to default)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::settings::schema::AppSettings;
    use tempfile::TempDir;

    fn test_app() -> (TempDir, AppHandle) {
        let directory = TempDir::new().unwrap();
        let config = rcman::SettingsConfig::builder("backend-options-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<AppSettings>()
            .build();
        let manager: AppSettingsManager = rcman::SettingsManager::new(config).unwrap();
        manager
            .register_sub_settings(rcman::SubSettingsConfig::singlefile(
                crate::utils::constants::SUB_BACKEND,
            ))
            .unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        (directory, app)
    }

    #[tokio::test]
    async fn persists_exact_values_for_the_initialization_loader() {
        let (_directory, app) = test_app();
        assert_eq!(
            load_backend_options_sync(app.state::<AppSettingsManager>().inner()),
            json!({})
        );
        let values = json!({
            "AskPassword": false,
            "Retries": 0,
            "LogFile": "",
            "HTTP.ListenAddr": "旅行 & Arşiv/özel",
            "ExcludeRule": ["folder/path", "space & symbols"],
            "Nullable": null
        });
        for (option, value) in values.as_object().unwrap() {
            save_rclone_backend_option(app.clone(), "main".into(), option.clone(), value.clone())
                .await
                .unwrap();
        }
        assert_eq!(
            load_backend_options_sync(app.state::<AppSettingsManager>().inner()),
            json!({"main": values})
        );
    }

    #[tokio::test]
    async fn removes_only_the_requested_override_and_drops_empty_blocks() {
        let (_directory, app) = test_app();
        for (option, value) in [("Retries", json!(0)), ("AskPassword", json!(false))] {
            save_rclone_backend_option(app.clone(), "main".into(), option.into(), value)
                .await
                .unwrap();
        }
        remove_rclone_backend_option(app.clone(), "main".into(), "Retries".into())
            .await
            .unwrap();
        assert_eq!(
            load_backend_options_sync(app.state::<AppSettingsManager>().inner()),
            json!({"main": {"AskPassword": false}})
        );
        remove_rclone_backend_option(app.clone(), "main".into(), "AskPassword".into())
            .await
            .unwrap();
        assert_eq!(
            load_backend_options_sync(app.state::<AppSettingsManager>().inner()),
            json!({})
        );
    }

    #[tokio::test]
    async fn removing_missing_or_non_object_blocks_is_a_no_op() {
        let (_directory, app) = test_app();
        remove_rclone_backend_option(app.clone(), "missing".into(), "Retries".into())
            .await
            .unwrap();
        let manager = app.state::<AppSettingsManager>();
        manager
            .sub_settings(crate::utils::constants::SUB_BACKEND)
            .unwrap()
            .set("main", &json!(false))
            .unwrap();
        remove_rclone_backend_option(app.clone(), "main".into(), "Retries".into())
            .await
            .unwrap();
        assert_eq!(
            load_backend_options_sync(manager.inner()),
            json!({"main": false})
        );
    }
}
