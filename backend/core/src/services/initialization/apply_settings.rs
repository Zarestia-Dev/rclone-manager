use log::{debug, error, info};

use crate::{
    rclone::{commands::system::bandwidth_limit, queries::flags::set_rclone_options_bulk},
    services::settings::{
        AppSettingsManager, rclone_backend::load_backend_options_sync, schema::AppSettings,
    },
};

/// Apply every core setting: the ones the engine needs, then the application's own.
pub async fn apply_core_settings(app_handle: &crate::context::AppHandle, settings: &AppSettings) {
    apply_engine_settings(app_handle, settings).await;
    apply_app_settings(settings);
}

/// Apply the settings a freshly started engine needs (bandwidth limit and rclone backend options)
pub async fn apply_engine_settings(app_handle: &crate::context::AppHandle, settings: &AppSettings) {
    // Bandwidth Limits
    if !settings.core.bandwidth_limit.is_empty() {
        debug!(
            "🌐 Setting bandwidth limit: {}",
            settings.core.bandwidth_limit
        );

        if let Err(e) = bandwidth_limit(
            app_handle.clone(),
            Some(settings.core.bandwidth_limit.clone()),
        )
        .await
        {
            error!("Failed to set bandwidth limit: {e}");
        }
    }

    // RClone backend settings from backend.json
    if let Err(e) = apply_backend_settings(app_handle).await {
        error!("Failed to apply backend settings: {e}");
    }
}

/// Apply the settings that belong to the application, not to the engine (log level and language)
pub fn apply_app_settings(settings: &AppSettings) {
    crate::utils::logging::log::update_log_level(&settings.developer.log_level);
    crate::utils::i18n::apply_language_change(&settings.general.language);
}

/// Apply `RClone` backend settings from rcman settings in a single bulk API request
pub async fn apply_backend_settings(app_handle: &crate::context::AppHandle) -> Result<(), String> {
    debug!("🔧 Applying RClone backend settings from rcman");

    let manager = app_handle.state::<AppSettingsManager>();
    let backend_options = load_backend_options_sync(manager.inner());

    // Only send request if there are options configured
    if let Some(obj) = backend_options.as_object()
        && !obj.is_empty()
    {
        set_rclone_options_bulk(app_handle.clone(), backend_options).await?;
        info!("✅ RClone backend settings applied successfully");
    }

    Ok(())
}
