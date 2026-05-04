use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use log::{debug, error, info};
use tauri::{AppHandle, Manager};

/// Phase 3: Data - Hydrates caches and ensures defaults
pub async fn initialize_caches(app_handle: &AppHandle) -> Result<(), String> {
    info!("📊 Phase 3: Refreshing caches...");

    // 1. Refresh Remote Caches (remotes, configs, mounts, serves)
    refresh_remote_cache(app_handle).await?;

    // 2. Seed default values (alerts, etc.)
    seed_system_defaults(app_handle)?;

    Ok(())
}

/// Refresh the main rclone remote cache
pub async fn refresh_remote_cache(app_handle: &AppHandle) -> Result<(), String> {
    let backend_manager = app_handle.state::<BackendManager>();

    match backend_manager
        .remote_cache
        .refresh_all(app_handle.clone())
        .await
    {
        Ok(()) => {
            debug!("✅ Refreshed backend caches");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to refresh backend caches: {e}");
            Err(e)
        }
    }
}

/// Seed default system values if they are missing
fn seed_system_defaults(app_handle: &AppHandle) -> Result<(), String> {
    let manager = app_handle.state::<AppSettingsManager>();

    // Seed Alert Defaults
    if let Err(e) = crate::core::alerts::seed::seed_defaults(manager.inner()) {
        error!("⚠️ Failed to seed alert defaults: {e}");
    }

    Ok(())
}
