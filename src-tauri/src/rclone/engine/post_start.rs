use crate::rclone::backend::BackendManager;
use crate::rclone::engine::lifecycle::clear_engine_errors;
use crate::utils::types::state::RcloneState;
use crate::{
    core::initialization::apply_settings::apply_core_settings,
    utils::types::events::RCLONE_ENGINE_READY,
};
use log::{debug, error};
use tauri::{AppHandle, Emitter, Manager};

pub fn trigger_post_start_setup(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<crate::core::settings::AppSettingsManager>();
        match manager.get_all() {
            Ok(settings) => {
                apply_core_settings(&app, &settings).await;
                clear_engine_errors(&app).await;
                refresh_caches_and_tray(&app).await;
            }
            Err(e) => {
                error!("Failed to load settings after engine start: {e}");
            }
        }

        if let Err(e) = app.emit(RCLONE_ENGINE_READY, ()) {
            error!("Failed to emit ready event: {e}");
        }
    });
}

async fn refresh_caches_and_tray(app: &AppHandle) {
    let client = app.state::<RcloneState>().client.clone();
    let backend_manager = app.state::<BackendManager>();

    if let Err(e) = crate::rclone::backend::connectivity::check_connectivity(
        &backend_manager,
        "Local",
        &client,
        None,
    )
    .await
    {
        error!("Failed to fetch Local backend runtime info: {e}");
    }

    let backend_manager = app.state::<BackendManager>();
    match backend_manager.remote_cache.refresh_all(app.clone()).await {
        Ok(()) => debug!("Refreshed backend caches"),
        Err(e) => error!("Failed to refresh backend caches: {e}"),
    }

    #[cfg(feature = "tray")]
    if let Err(e) = crate::core::tray::core::update_tray_menu(app.clone()).await {
        error!("Failed to update tray menu: {e}");
    }
}
