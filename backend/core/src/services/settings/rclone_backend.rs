//! `RClone` Backend Settings Manager (using rcman sub-settings single-file mode)

use crate::context::AppHandle;
use crate::services::settings::with_sub_settings;
use crate::utils::constants::SUB_BACKEND;
use log::{debug, info};
use serde_json::{Map, Value, json};

use crate::rclone::engine::lifecycle::restart_for_config_change;

/// Every saved option block, keyed by block name.
pub async fn load_backend_options(app: &AppHandle) -> Result<Value, String> {
    with_sub_settings(
        app,
        SUB_BACKEND,
        "backendErrors.settings.loadFailed",
        |backend| backend.get_all_values().map(|blocks| json!(blocks)),
    )
    .await
}

/// Save a single `RClone` backend option (block.option format)
pub async fn save_rclone_backend_option(
    app: AppHandle,
    block: String,
    option: String,
    value: Value,
) -> Result<(), String> {
    debug!("Saving RClone option: {block}.{option}");
    let (saved_block, saved_option) = (block.clone(), option.clone());
    with_sub_settings(
        &app,
        SUB_BACKEND,
        "backendErrors.settings.saveFailed",
        move |backend| {
            // One locked read-modify-write, so concurrent saves of different
            // options in the same block cannot overwrite each other. Option names
            // may contain dots (`HTTP.ListenAddr`), which is why this is not `set_field`.
            backend.update(&saved_block, move |current| {
                let mut options = match current {
                    Some(Value::Object(options)) => options,
                    _ => Map::new(),
                };
                options.insert(saved_option, value);
                Some(Value::Object(options))
            })
        },
    )
    .await?;

    info!("RClone option {block}.{option} saved");
    Ok(())
}

/// Reset `RClone` backend options to defaults (delete all) and restart engine
pub async fn reset_rclone_backend_options(app: AppHandle) -> Result<(), String> {
    debug!("Resetting RClone backend options");
    with_sub_settings(
        &app,
        SUB_BACKEND,
        "backendErrors.settings.deleteEntryFailed",
        |backend| {
            for block in backend.list()? {
                backend.delete(&block)?;
            }
            Ok(())
        },
    )
    .await?;

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
    let (removed_block, removed_option) = (block.clone(), option.clone());
    with_sub_settings(
        &app,
        SUB_BACKEND,
        "backendErrors.settings.saveFailed",
        move |backend| {
            backend.update(&removed_block, move |current| match current {
                Some(Value::Object(mut options)) => {
                    options.remove(&removed_option);
                    // A block with no overrides left is dropped entirely.
                    (!options.is_empty()).then_some(Value::Object(options))
                }
                // Missing (stays missing) or not an object (left as found).
                other => other,
            })
        },
    )
    .await?;

    info!("RClone option {block}.{option} removed (reset to default)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::settings::{AppSettingsManager, schema::AppSettings};
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
        assert_eq!(load_backend_options(&app).await.unwrap(), json!({}));
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
            load_backend_options(&app).await.unwrap(),
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
            load_backend_options(&app).await.unwrap(),
            json!({"main": {"AskPassword": false}})
        );
        remove_rclone_backend_option(app.clone(), "main".into(), "AskPassword".into())
            .await
            .unwrap();
        assert_eq!(load_backend_options(&app).await.unwrap(), json!({}));
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
            load_backend_options(&app).await.unwrap(),
            json!({"main": false})
        );
    }

    #[tokio::test]
    async fn concurrent_saves_to_one_block_keep_every_option() {
        let (_directory, app) = test_app();
        let saves: Vec<_> = (0..16)
            .map(|index| {
                let app = app.clone();
                crate::utils::spawn(async move {
                    save_rclone_backend_option(
                        app,
                        "main".into(),
                        format!("Option{index}"),
                        json!(index),
                    )
                    .await
                    .unwrap();
                })
            })
            .collect();
        for save in saves {
            save.await.unwrap();
        }
        let options = load_backend_options(&app).await.unwrap();
        assert_eq!(options["main"].as_object().unwrap().len(), 16);
    }

    #[tokio::test]
    async fn an_unreadable_store_is_reported_instead_of_treated_as_empty() {
        let (directory, app) = test_app();
        save_rclone_backend_option(app.clone(), "main".into(), "Retries".into(), json!(1))
            .await
            .unwrap();
        std::fs::write(directory.path().join("backend.json"), "{ not json").unwrap();
        app.state::<AppSettingsManager>().invalidate_cache();

        assert!(load_backend_options(&app).await.is_err());
        assert!(
            save_rclone_backend_option(app, "main".into(), "Other".into(), json!(2))
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("backend.json")).unwrap(),
            "{ not json"
        );
    }
}
