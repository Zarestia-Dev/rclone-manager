use crate::core::settings::AppSettingsManager;
use crate::core::settings::schema::AppSettings;
use log::info;
use std::path::Path;

/// Creates a new `AppSettingsManager` with all necessary sub-settings and migrators.
///
/// This does NOT perform slow migrations (like keyring migration).
pub fn create_settings_manager(config_dir: &Path) -> Result<AppSettingsManager, String> {
    rcman::SettingsManager::builder(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
        .with_config_dir(config_dir)
        .with_env_credentials()
        .with_schema::<AppSettings>()
        .with_migrator(|mut value: serde_json::Value| {
            if let Some(root) = value.as_object_mut() {
                // Flatten legacy app_settings if present
                if let Some(app_settings) = root.remove("app_settings") {
                    info!("found legacy app_settings, flattening to root");
                    if let Some(app_settings_obj) = app_settings.as_object() {
                        for (k, v) in app_settings_obj {
                            if !root.contains_key(k) {
                                root.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }

                // Migrate rclone_path to rclone_binary and ensure it ends with the binary name
                if let Some(core) = root.get_mut("core")
                    && let Some(core_obj) = core.as_object_mut()
                {
                    let bin_name = if cfg!(windows) {
                        "rclone.exe"
                    } else {
                        "rclone"
                    };

                    let rclone_binary = if let Some(old_path) = core_obj.remove("rclone_path") {
                        info!("migrating core.rclone_path to core.rclone_binary");
                        Some(old_path)
                    } else {
                        core_obj.get("rclone_binary").cloned()
                    };

                    if let Some(path_str) = rclone_binary.as_ref().and_then(|v| v.as_str())
                        && !path_str.is_empty()
                        && path_str != "system"
                        && !path_str.ends_with(bin_name)
                    {
                        let mut path = std::path::PathBuf::from(path_str);
                        path.push(bin_name);
                        core_obj.insert(
                            "rclone_binary".to_string(),
                            serde_json::Value::String(path.to_string_lossy().to_string()),
                        );
                    } else if let Some(path_val) = rclone_binary {
                        core_obj.insert("rclone_binary".to_string(), path_val);
                    }
                }
            }
            value
        })
        .with_sub_settings(
            rcman::SubSettingsConfig::new("remotes")
                .with_profiles()
                .with_migrator(crate::core::settings::remote::manager::migrate_to_multi_profile),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("backend")
                .with_profiles()
                .with_migrator(|mut value: serde_json::Value| {
                    if let Some(root) = value.as_object_mut()
                        && let Some(backend_settings) = root.remove("backend")
                    {
                        info!("found legacy backend settings, flattening to root");
                        if let Some(backend_obj) = backend_settings.as_object() {
                            for (k, v) in backend_obj {
                                if !root.contains_key(k) {
                                    root.insert(k.clone(), v.clone());
                                }
                            }
                        }
                    }
                    value
                }),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("connections")
                .with_schema::<crate::rclone::backend::schema::BackendConnectionSchema>(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("alerts/rules")
                .with_schema::<crate::core::alerts::types::AlertRule>(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("alerts/actions")
                .with_schema::<crate::core::alerts::types::AlertAction>(),
        )
        .build()
        .map_err(|e| format!("Failed to create rcman settings manager: {e}"))
}
