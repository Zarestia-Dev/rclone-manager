use crate::core::settings::AppSettingsManager;
use crate::core::settings::schema::AppSettings;
use std::path::Path;

/// Creates a new `AppSettingsManager` with all necessary sub-settings.
pub fn create_settings_manager(config_dir: &Path) -> Result<AppSettingsManager, String> {
    rcman::SettingsManager::builder(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
        .with_config_dir(config_dir)
        .with_env_credentials()
        .with_schema::<AppSettings>()
        .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
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
        .build()
        .map_err(|e| format!("Failed to create rcman settings manager: {e}"))
}
