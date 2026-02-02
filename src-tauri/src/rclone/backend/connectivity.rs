// Backend connectivity and fallback logic

use crate::rclone::backend::BackendManager;
use log::info;
use tauri::Manager;

/// Check connectivity to a backend, updating cache if successful
/// Returns (version, os) on success
pub async fn check_connectivity(
    manager: &BackendManager,
    name: &str,
    client: &reqwest::Client,
) -> Result<(String, String), String> {
    let backend = manager
        .get(name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", name))?;

    let timeout = std::time::Duration::from_secs(5);
    let runtime_info =
        crate::rclone::backend::runtime::fetch_runtime_info(&backend, client, timeout).await;

    let version = runtime_info.version().unwrap_or_default();
    let os = runtime_info.os().unwrap_or_default();

    if !runtime_info.is_connected() {
        if let Some(error) = runtime_info.error_message() {
            return Err(error);
        }
        return Err("Connection failed".to_string());
    }

    manager.set_runtime_info(name, runtime_info).await;

    Ok((version, os))
}

/// Check connectivity with a specified timeout
/// Returns detailed error message on failure or timeout
pub async fn check_connectivity_with_timeout(
    manager: &BackendManager,
    name: &str,
    client: &reqwest::Client,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let check_future = check_connectivity(manager, name, client);

    match tokio::time::timeout(timeout, check_future).await {
        Ok(result) => result,
        Err(_) => Err(format!("Connection timed out after {}s", timeout.as_secs())),
    }
}

/// Check Local backend connectivity with retries (used during startup)
/// Retries every 500ms until timeout
pub async fn check_local_connectivity_retrying(
    manager: &BackendManager,
    client: &reqwest::Client,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let check_local_future = async {
        let mut attempts = 0;
        loop {
            match check_connectivity(manager, "Local", client).await {
                Ok(info) => return Ok(info),
                Err(e) => {
                    attempts += 1;
                    if attempts % 2 == 0 {
                        log::debug!("⚠️ Local backend check attempt {} failed: {}", attempts, e);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        }
    };

    match tokio::time::timeout(timeout, check_local_future).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Local backend check timed out after {}s",
            timeout.as_secs()
        )),
    }
}

/// Ensure valid connectivity for the active backend, automatically failing back to Local if needed.
/// This orchestrates the entire startup connectivity check process.
pub async fn ensure_connectivity_or_fallback(
    manager: &BackendManager,
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let active_name = manager.get_active_name().await;

    if active_name == "Local" {
        info!(
            "🔍 Checking Local backend for version/OS info (timeout: {}s)",
            timeout.as_secs()
        );

        return match check_local_connectivity_retrying(manager, client, timeout).await {
            Ok(_) => {
                info!("✅ Local backend is reachable and runtime info loaded");
                Ok(())
            }
            Err(_) => {
                log::warn!(
                    "⚠️ Local backend check timed out after {}s. Marking as connected but runtime info may be missing.",
                    timeout.as_secs()
                );
                // Still mark as connected since it's managed by us
                manager.set_runtime_status("Local", "connected").await;
                Ok(())
            }
        };
    }

    info!(
        "🔍 Checking connectivity for active backend: {} (timeout: {}s)",
        active_name,
        timeout.as_secs()
    );

    match check_connectivity_with_timeout(manager, &active_name, client, timeout).await {
        Ok(_) => {
            info!("✅ Active backend '{}' is reachable", active_name);
            Ok(())
        }
        Err(e) => {
            log::warn!(
                "⚠️ Active backend '{}' connectivity failed: {}. Falling back to Local.",
                active_name,
                e
            );

            manager
                .set_runtime_status(&active_name, &format!("error:{}", e))
                .await;

            if let Err(fallback_err) = switch_to_local_fallback(manager, app, client).await {
                let msg = format!(
                    "Critical: Failed to fallback to Local backend: {}",
                    fallback_err
                );
                log::error!("{}", msg);
                Err(msg)
            } else {
                info!("✅ Fallback to Local backend successful");
                manager.set_runtime_status("Local", "connected").await;
                Ok(())
            }
        }
    }
}

/// Emergency fallback to Local backend (NO profile switching)
///
/// This is a "best effort" fallback used during startup connectivity checks
/// when the active remote backend is unreachable. Unlike `BackendManager::switch_to()`,
/// this function does NOT switch settings profiles, only updates internal backend state.
///
/// # Use Cases
/// - Automatic fallback during app initialization
/// - Recovery from remote backend connectivity failures
/// - Temporary fallback until user manually switches
///
/// # Warning
/// ⚠️ This may leave profile settings mismatched with the active backend.
/// For full backend switches with profile management, use `BackendManager::switch_to()`.
///
/// # What it does
/// 1. Switches the active backend index to Local
/// 2. Updates the `is_local` flag
/// 3. Starts Local engine if not already running (lazy init)
///
/// # What it does NOT do
/// - Switch settings profiles (remotes/backend)
/// - Save state from previous backend  
/// - Restore Local backend state
pub async fn switch_to_local_fallback(
    manager: &BackendManager,
    app: &tauri::AppHandle,
    _client: &reqwest::Client,
) -> Result<(), String> {
    use crate::utils::types::core::EngineState;

    // 1. Reset profiles to default (Local)
    reset_profiles_to_default(app).await;

    // 2. Switch active index to Local
    manager.switch_to_local_index().await?;

    crate::rclone::engine::core::set_active_is_local(true);
    info!("🔄 Fallback switched to internal Local backend state");

    // 3. Start Local engine if not running (lazy init on fallback)
    let engine_state = app.state::<EngineState>();
    let mut engine = engine_state.lock().await;

    if !engine.running && !engine.path_error && !engine.password_error {
        info!("🚀 Starting Local engine after fallback from Remote...");
        engine.init(app).await;
    }

    Ok(())
}

/// Helper to reset settings profiles to default (used during fallback)
async fn reset_profiles_to_default(app: &tauri::AppHandle) {
    use crate::core::settings::AppSettingsManager;
    let settings_manager = app.state::<AppSettingsManager>();

    // Helper to switch a sub-setting profile safely
    async fn switch_profile(manager: &AppSettingsManager, sub: &str) {
        if let Ok(s) = manager.sub_settings(sub) {
            let _ = s.switch_profile("default");
        }
    }

    switch_profile(settings_manager.inner(), "remotes").await;
    switch_profile(settings_manager.inner(), "backend").await;
    info!("👤 Fallback switched profiles to default");
}

/// Check non-active backends in background
pub async fn check_other_backends(manager: &BackendManager, client: &reqwest::Client) {
    let backends = manager.list_all().await;
    let active_name = manager.get_active_name().await;

    for backend in backends {
        if backend.name == active_name || backend.name == "Local" {
            continue; // Already checked
        }

        info!("🔍 Background check for backend: {}", backend.name);
        if let Err(e) = check_connectivity(manager, &backend.name, client).await {
            log::warn!("⚠️ Backend '{}' unreachable: {}", backend.name, e);
            manager
                .set_runtime_status(&backend.name, &format!("error:{}", e))
                .await;
        } else {
            info!("✅ Backend '{}' is reachable", backend.name);
        }
    }
}

#[cfg(test)]
mod tests {
    // TODO: Add connectivity tests
    // - Test successful connectivity check
    // - Test connection timeout
    // - Test retry logic for Local backend
    // - Test fallback on remote failure
    // - Test background checks
}
