use crate::context::AppHandle;
use log::{debug, error};

use crate::{
    rclone::backend::BackendManager,
    services::initialization::apply_settings::apply_core_settings,
    utils::types::events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED},
};

pub async fn run_post_start_setup(app: &AppHandle) {
    let manager = app.state::<crate::services::settings::AppSettingsManager>();
    let settings_result = manager.get_all();

    match settings_result {
        Ok(settings) => {
            apply_core_settings(app, &settings).await;
            refresh_caches_and_tray(app).await;

            crate::services::bridge::emit(RCLONE_ENGINE_STATUS_CHANGED, EngineStatus::Ready);
        }
        Err(e) => {
            error!(
                "Post-start: Failed to load settings — skipping cache refresh and Ready event: {e}"
            );
        }
    }
}

async fn refresh_caches_and_tray(app: &AppHandle) {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let transport = crate::rclone::backend::routing_transport::RoutingTransport::for_backend(
        app.clone(),
        backend.clone(),
    );
    let active_name = &backend.name;

    if let Err(e) = crate::rclone::backend::connectivity::check_connectivity(
        &backend_manager,
        active_name,
        &*transport,
        None,
    )
    .await
    {
        error!("Post-start: Failed to fetch '{active_name}' backend runtime info: {e}");
    }

    if let Err(e) = backend_manager
        .remote_cache_for(&backend.name)
        .refresh_all(app.clone(), &backend)
        .await
    {
        error!("Post-start: Failed to refresh backend connection caches: {e}");
    } else {
        debug!("Post-start: Successfully refreshed backend connection caches");
    }

    crate::services::bridge::emit(crate::utils::types::events::UPDATE_TRAY_MENU, ());
}
