use crate::context::AppHandle;
use log::{debug, warn};

use crate::rclone::backend::{BackendManager, types::Backend};

/// Force refresh mounted remotes for the selected backend.
pub async fn force_check_mounted_remotes(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let backend = manager.get_active().await;
    manager
        .remote_cache_for(&backend.name)
        .refresh_mounted_remotes(app, &backend)
        .await
}

/// Force refresh running serves for the selected backend.
pub async fn force_check_serves(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let backend = manager.get_active().await;
    manager
        .remote_cache_for(&backend.name)
        .refresh_serves(app, &backend)
        .await
}

/// Refresh the owning backend after a mount operation, logging refresh failures.
pub async fn refresh_mounts_quietly(app: &AppHandle, backend: &Backend) {
    debug!("Refreshing mounts for '{}'", backend.name);
    let cache = app
        .state::<BackendManager>()
        .remote_cache_for(&backend.name);
    if let Err(error) = cache.refresh_mounted_remotes(app.clone(), backend).await {
        warn!(
            "Failed to refresh mounted remotes for '{}': {error}",
            backend.name
        );
    }
}

/// Refresh the owning backend after a serve operation, logging refresh failures.
pub async fn refresh_serves_quietly(app: &AppHandle, backend: &Backend) {
    debug!("Refreshing serves for '{}'", backend.name);
    let cache = app
        .state::<BackendManager>()
        .remote_cache_for(&backend.name);
    if let Err(error) = cache.refresh_serves(app.clone(), backend).await {
        warn!("Failed to refresh serves for '{}': {error}", backend.name);
    }
}
