// Post-start setup orchestration
//
// Functions that run after the engine successfully starts,
// including settings application and cache refresh

use crate::core::initialization::apply_settings::apply_core_settings;
use crate::core::settings::operations::core::load_startup_settings;
use crate::rclone::backend::BackendManager;
use crate::utils::types::core::{EngineState, RcloneState};
use log::{debug, error};
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use crate::core::tray::core::update_tray_menu;

/// Trigger post-start actions after engine is ready
///
/// Spawns async task to:
/// 1. Load and apply startup settings
/// 2. Clear engine error states
/// 3. Refresh caches and tray menu
pub fn trigger_post_start_setup(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Load and apply settings
        match load_startup_settings(&app.state::<crate::core::settings::AppSettingsManager>()) {
            Ok(settings) => {
                apply_core_settings(&app, &settings).await;

                // Clear errors (synchronous, but fast enough to not need blocking spawn)
                app.state::<EngineState>().lock().await.clear_errors();

                // Refresh caches
                refresh_caches_and_tray(&app).await;
            }
            Err(e) => {
                error!("Failed to load settings to apply after engine start: {}", e);
            }
        }
    });
}

/// Refresh backend caches and update tray menu
async fn refresh_caches_and_tray(app: &AppHandle) {
    let client = app.state::<RcloneState>().client.clone();

    // Fetch runtime info for Local backend (version, OS, config_path)
    // This is deterministic since we're called AFTER engine is confirmed ready
    let backend_manager = app.state::<BackendManager>();
    if let Err(e) = backend_manager.check_connectivity("Local", &client).await {
        error!("Failed to fetch Local backend runtime info: {e}");
    }

    // Refresh active backend caches
    match backend_manager.refresh_active_backend(&client).await {
        Ok(_) => debug!("Refreshed backend caches"),
        Err(e) => error!("Failed to refresh backend caches: {e}"),
    }

    // Update tray menu on desktop
    #[cfg(desktop)]
    if let Err(e) = update_tray_menu(app.clone()).await {
        error!("Failed to update tray menu: {e}");
    }
}

#[cfg(test)]
mod tests {
    // TODO: Add post-start tests
    // - Test settings application on startup
    // - Test cache refresh
    // - Test error handling for failed settings load
    // - Test tray menu update (desktop only)
}
