use log::{debug, error};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::initialization::apply_settings::apply_core_settings,
    rclone::backend::BackendManager,
    utils::types::{
        events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED},
        state::RcloneState,
    },
};

pub async fn run_post_start_setup(app: &AppHandle) {
    let manager = app.state::<crate::core::settings::AppSettingsManager>();
    let settings_result = manager.get_all();

    match settings_result {
        Ok(settings) => {
            apply_core_settings(app, &settings).await;
            refresh_caches_and_tray(app).await;

            if let Err(e) = app.emit(RCLONE_ENGINE_STATUS_CHANGED, EngineStatus::Ready) {
                error!("Post-start: Failed to emit ready event: {e}");
            }
        }
        Err(e) => {
            error!(
                "Post-start: Failed to load settings — skipping cache refresh and Ready event: {e}"
            );
        }
    }
}

async fn refresh_caches_and_tray(app: &AppHandle) {
    let transport = app.state::<RcloneState>().transport.clone();
    let backend_manager = app.state::<BackendManager>();
    let active_name = backend_manager.get_active_name().await;

    if let Err(e) = crate::rclone::backend::connectivity::check_connectivity(
        &backend_manager,
        &active_name,
        &*transport,
        None,
    )
    .await
    {
        error!("Post-start: Failed to fetch '{active_name}' backend runtime info: {e}");
    }

    if let Err(e) = backend_manager.remote_cache.refresh_all(app.clone()).await {
        error!("Post-start: Failed to refresh backend connection caches: {e}");
    } else {
        debug!("Post-start: Successfully refreshed backend connection caches");
    }

    #[cfg(feature = "tray")]
    if let Err(e) = crate::core::tray::core::update_tray_menu(app.clone()).await {
        error!("Post-start: Failed to update tray menu: {e}");
    }
}
