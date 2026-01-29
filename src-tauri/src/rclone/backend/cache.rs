// Backend cache refresh logic

use crate::rclone::backend::BackendManager;

/// Refresh all caches for the currently active backend
///
/// This is the central method for updating state from the API.
/// It should be used by:
/// 1. Backend switching logic
/// 2. Engine startup/initialization
/// 3. Manual refresh actions
pub async fn refresh_active_backend(
    manager: &BackendManager,
    client: &reqwest::Client,
) -> Result<(), String> {
    let backend = manager.get_active().await;
    manager.remote_cache.refresh_all(client, &backend).await
}

#[cfg(test)]
mod tests {
    // TODO: Add cache refresh tests
    // - Test successful refresh
    // - Test refresh failure handling
    // - Test remote list caching
    // - Test job cache updates
}
