use crate::rclone::backend::BackendManager;
use crate::utils::types::core::RcloneState;
use log::error;
use tauri::Manager;

/// Timeout for backend connectivity checks (10 seconds)
/// After this timeout, the app will fallback to Local backend
const BACKEND_CONNECTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Check if the active backend is reachable; fallback to Local if not.
/// Also spawns background checks for other backends.
pub async fn check_active_backend_connectivity(app_handle: &tauri::AppHandle) {
    let backend_manager = app_handle.state::<BackendManager>();

    // Skip redundant check for Local backend since engine already waits for API readiness
    // This saves ~500ms on startup
    let active_name = backend_manager.get_active_name().await;
    let client = app_handle.state::<RcloneState>().client.clone();

    if active_name == "Local" {
        log::info!(
            "⏭️ Skipping redundant Local backend connectivity check (already verified during engine startup)"
        );
        backend_manager
            .set_runtime_status("Local", "connected")
            .await;
    } else {
        // For remote backends, check connectivity with automatic fallback
        // This single call handles:
        // 1. Checking Active (Remote)
        // 2. Fallback to Local (if Remote fails)
        // 3. Logging success/failure
        if let Err(e) = backend_manager
            .ensure_connectivity_or_fallback(app_handle, &client, BACKEND_CONNECTIVITY_TIMEOUT)
            .await
        {
            error!("🔥 Critical startup failure: {}", e);
        }
    }

    // Spawn background task to check other backends (non-blocking)
    let app_handle_clone = app_handle.clone();
    tokio::spawn(async move {
        check_other_backends(&app_handle_clone).await;
    });
}

/// Background check for non-active backends
async fn check_other_backends(app_handle: &tauri::AppHandle) {
    let backend_manager = app_handle.state::<BackendManager>();

    let client = app_handle.state::<RcloneState>().client.clone();

    backend_manager.check_other_backends(&client).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests would require mocking the AppHandle and BackendManager
    // For now, we'll add basic structure tests

    #[test]
    fn test_connectivity_timeout_constant() {
        assert_eq!(BACKEND_CONNECTIVITY_TIMEOUT.as_secs(), 10);
    }

    // TODO: Add integration tests with mocked BackendManager
    // - Test fallback on remote failure
    // - Test retry logic for Local backend
    // - Test background check spawning
}
