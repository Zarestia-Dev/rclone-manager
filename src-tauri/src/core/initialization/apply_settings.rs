use crate::core::settings::AppSettingsManager;
use crate::core::settings::rclone_backend::load_backend_options_sync;
use crate::core::settings::schema::AppSettings;
use crate::rclone::commands::system::set_bandwidth_limit;
use crate::rclone::queries::flags::set_rclone_options_bulk;
use log::{debug, error, info};
use tauri::Manager;

/// Apply core settings on startup (bandwidth limits, backend options, language, and log level)
pub async fn apply_core_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) {
    // Bandwidth Limits
    if !settings.core.bandwidth_limit.is_empty() {
        debug!(
            "🌐 Setting bandwidth limit: {}",
            settings.core.bandwidth_limit
        );

        if let Err(e) = set_bandwidth_limit(
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

    // Log Level
    crate::utils::logging::log::update_log_level(&settings.developer.log_level);

    // Language
    crate::utils::i18n::apply_language_change(app_handle, &settings.general.language);
}

/// Apply `RClone` backend settings from rcman settings in a single bulk API request
pub async fn apply_backend_settings(app_handle: &tauri::AppHandle) -> Result<(), String> {
    debug!("🔧 Applying RClone backend settings from rcman");

    let manager = app_handle.state::<AppSettingsManager>();
    let backend_options = load_backend_options_sync(manager.inner());

    // Only send request if there are options configured
    if let Some(obj) = backend_options.as_object()
        && !obj.is_empty()
        && let Err(e) = set_rclone_options_bulk(app_handle.clone(), backend_options).await
    {
        error!("Failed to apply bulk backend settings: {e}");
    }

    info!("✅ RClone backend settings applied successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    // Basic structural tests for settings application could be added here
}
