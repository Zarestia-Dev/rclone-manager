// Backend connectivity and fallback logic

use crate::rclone::backend::BackendManager;
use log::info;

/// Check connectivity to a backend, updating cache if successful.
/// Returns (version, os) on success.
pub async fn check_connectivity(
    manager: &BackendManager,
    name: &str,
    client: &reqwest::Client,
    timeout: Option<std::time::Duration>,
) -> Result<(String, String), String> {
    let backend = manager
        .get(name)
        .await
        .ok_or_else(|| format!("Backend '{}' not found", name))?;

    let timeout = timeout.unwrap_or(std::time::Duration::from_secs(5));
    let runtime_info = backend.fetch_runtime_info(client, timeout).await;

    let version = runtime_info.version.clone().unwrap_or_default();
    let os = runtime_info.os.clone().unwrap_or_default();

    if !runtime_info.is_connected() {
        return Err(runtime_info
            .error_message()
            .unwrap_or_else(|| "Connection failed".to_string()));
    }

    manager.set_runtime_info(name, runtime_info).await;

    Ok((version, os))
}

/// Check connectivity with a hard timeout.
/// Returns a clear error message on failure or timeout.
pub async fn check_connectivity_with_timeout(
    manager: &BackendManager,
    name: &str,
    client: &reqwest::Client,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    match tokio::time::timeout(
        timeout,
        check_connectivity(manager, name, client, Some(timeout)),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!("Connection timed out after {}s", timeout.as_secs())),
    }
}

/// Check Local backend connectivity with retries (used during startup).
/// Retries every 500 ms until the outer timeout fires.
pub async fn check_local_connectivity_retrying(
    manager: &BackendManager,
    client: &reqwest::Client,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let check_local = async {
        let mut attempts = 0u32;
        loop {
            match check_connectivity(manager, "Local", client, None).await {
                Ok(info) => return Ok(info),
                Err(e) => {
                    attempts += 1;
                    if attempts.is_multiple_of(2) {
                        log::debug!("⚠️ Local backend check attempt {} failed: {}", attempts, e);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        }
    };

    match tokio::time::timeout(timeout, check_local).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Local backend check timed out after {}s",
            timeout.as_secs()
        )),
    }
}

/// Ensure the active backend is reachable at startup.
///
/// - Local backend: retries until connected or timeout, then marks connected anyway
///   (we manage the process, so it will come up).
/// - Remote backend: single attempt with timeout; marks offline without switching.
///   The user explicitly chose this backend — we respect that even if it is
///   temporarily unreachable. The UI shows the offline status.
pub async fn ensure_connectivity_or_fallback(
    manager: &BackendManager,
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
                    "⚠️ Local backend timed out after {}s. Marking connected; runtime info may be missing.",
                    timeout.as_secs()
                );
                manager.set_runtime_status("Local", "connected").await;
                Ok(())
            }
        };
    }

    info!(
        "🔍 Checking active backend: {} (timeout: {}s)",
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
                "⚠️ Active backend '{}' unreachable: {}. Marking offline.",
                active_name,
                e
            );
            manager
                .set_runtime_status(&active_name, &format!("error:{}", e))
                .await;
            Ok(())
        }
    }
}

/// Check non-active backends in the background (best-effort, no fallback).
pub async fn check_other_backends(manager: &BackendManager, client: &reqwest::Client) {
    let backends = manager.list_all().await;
    let active_name = manager.get_active_name().await;

    for backend in backends {
        if backend.name == active_name || backend.name == "Local" {
            continue;
        }

        info!("🔍 Background check for backend: {}", backend.name);
        match check_connectivity(manager, &backend.name, client, None).await {
            Ok(_) => info!("✅ Backend '{}' is reachable", backend.name),
            Err(e) => {
                log::warn!("⚠️ Backend '{}' unreachable: {}", backend.name, e);
                manager
                    .set_runtime_status(&backend.name, &format!("error:{}", e))
                    .await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::BackendManager;

    #[tokio::test]
    async fn test_check_connectivity_unknown_backend() {
        let manager = BackendManager::new();
        let client = reqwest::Client::new();
        let result = check_connectivity(&manager, "DoesNotExist", &client, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}
