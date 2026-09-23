use serde_json::Value;
use std::path::Path;

use crate::core::settings::AppSettingsManager;
use crate::core::settings::schema::AppSettings;

/// Migrator for `remotes` sub-settings: delegates to `migrate_to_multi_profile`.
pub fn migrate_remote_sub_settings(val: Value) -> Value {
    crate::core::settings::remote::manager::migrate_to_multi_profile(val)
}

/// Creates a new `AppSettingsManager` with all necessary sub-settings.
pub fn create_settings_manager(config_dir: &Path) -> Result<AppSettingsManager, String> {
    rcman::SettingsManager::builder(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
        .with_config_dir(config_dir)
        .with_env_credentials()
        .with_schema::<AppSettings>()
        .with_sub_settings(
            rcman::SubSettingsConfig::new("remotes")
                .with_profiles()
                .with_migrator(migrate_remote_sub_settings),
        )
        .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("connections")
                .with_schema::<crate::rclone::backend::types::Backend>(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("alerts/rules")
                .with_schema::<crate::core::alerts::types::AlertRule>(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("alerts/actions")
                .with_schema::<crate::core::alerts::types::AlertAction>(),
        )
        .with_sub_settings(rcman::SubSettingsConfig::singlefile(
            crate::utils::constants::SUB_QUICK_RUNS,
        ))
        .with_sub_settings(rcman::SubSettingsConfig::singlefile(
            crate::utils::constants::SUB_WORKFLOWS,
        ))
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile(crate::utils::constants::SUB_TEMPLATES)
                .with_schema::<crate::core::settings::schema::UserPresetTemplate>(),
        )
        .build()
        .map_err(|e| format!("Failed to create rcman settings manager: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_migrate_remote_sub_settings_double_nested() {
        let legacy = json!({
            "runtimeRemoteConfigs": {
                "Default": {
                    "One Drive": {
                        "token": "secret_token",
                        "client_credentials": true
                    }
                }
            }
        });

        let migrated = migrate_remote_sub_settings(legacy);
        let default_profile = &migrated["runtimeRemoteConfigs"]["Default"];

        assert_eq!(default_profile["token"], "secret_token");
        assert_eq!(default_profile["client_credentials"], true);
        assert!(default_profile.get("One Drive").is_none());
    }

    #[test]
    fn test_migrate_remote_sub_settings_already_flat() {
        let flat = json!({
            "runtimeRemoteConfigs": {
                "Default": {
                    "token": "secret_token",
                    "client_credentials": true
                }
            }
        });

        let migrated = migrate_remote_sub_settings(flat.clone());
        assert_eq!(migrated, flat);
    }
}
