use crate::core::settings::AppSettingsManager;
use crate::core::settings::schema::AppSettings;
use crate::rclone::commands::system::set_bandwidth_limit;
use crate::rclone::queries::flags::set_rclone_option;
use log::{debug, error, info};
use tauri::Manager;

/// Apply core settings on startup (bandwidth limits and backend options)
pub async fn apply_core_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) {
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

    // Apply RClone backend settings from backend.json
    if let Err(e) = apply_backend_settings(app_handle).await {
        error!("Failed to apply backend settings: {e}");
    }
}

/// Apply RClone backend settings from rcman settings
pub async fn apply_backend_settings(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use crate::core::settings::rclone_backend::load_backend_options_sync;

    debug!("🔧 Applying RClone backend settings from rcman");

    let manager = app_handle.state::<AppSettingsManager>();
    let backend_options = load_backend_options_sync(manager.inner());

    if let Some(backend_obj) = backend_options.as_object() {
        for (block_name, block_options) in backend_obj {
            if let Some(options_obj) = block_options.as_object() {
                for (option_name, option_value) in options_obj {
                    debug!(
                        "🔧 Setting RClone option: {}.{} = {:?}",
                        block_name, option_name, option_value
                    );

                    if let Err(e) = set_rclone_option(
                        app_handle.clone(),
                        block_name.clone(),
                        option_name.clone(),
                        option_value.clone(),
                    )
                    .await
                    {
                        error!(
                            "Failed to set RClone option {}.{}: {}",
                            block_name, option_name, e
                        );
                    }
                }
            }
        }
    }

    info!("✅ RClone backend settings applied successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    // TODO: Add settings application tests
    // - Test bandwidth limit application
    // - Test backend settings application
    // - Test empty settings handling
    // - Test invalid settings error handling
}
