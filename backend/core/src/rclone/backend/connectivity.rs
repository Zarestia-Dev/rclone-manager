use crate::rclone::backend::runtime::RuntimeStatus;
use crate::rclone::backend::{BackendManager, RcloneTransport};
use crate::utils::constants::LOCAL_BACKEND_NAME;
use log::{debug, info, warn};

pub async fn check_connectivity(
    manager: &BackendManager,
    name: &str,
    transport: &dyn RcloneTransport,
    timeout: Option<std::time::Duration>,
) -> Result<(String, String), String> {
    let backend = manager
        .get(name)
        .await
        .ok_or_else(|| format!("Backend '{name}' not found"))?;

    let timeout = timeout.unwrap_or(std::time::Duration::from_secs(5));
    let runtime_info = backend.fetch_runtime_info(transport, timeout).await;

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

pub async fn check_connectivity_with_timeout(
    manager: &BackendManager,
    name: &str,
    transport: &dyn RcloneTransport,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    match tokio::time::timeout(
        timeout,
        check_connectivity(manager, name, transport, Some(timeout)),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!("Connection timed out after {}s", timeout.as_secs())),
    }
}

/// Time a user-visible probe waits for a backend before calling it unreachable.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Probes `name` and records the outcome, so a stored status never outlives the last probe.
/// A failure keeps the last known version and OS next to the error status.
pub async fn probe_backend(
    manager: &BackendManager,
    name: &str,
    transport: &dyn RcloneTransport,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let result = check_connectivity_with_timeout(manager, name, transport, timeout).await;
    if let Err(error) = &result {
        manager
            .set_runtime_status(name, RuntimeStatus::Error(error.clone()))
            .await;
    }
    result
}

pub async fn check_local_connectivity_retrying(
    manager: &BackendManager,
    transport: &dyn RcloneTransport,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let check_local = async {
        let mut attempts = 0u32;
        loop {
            attempts += 1;
            match check_connectivity(manager, LOCAL_BACKEND_NAME, transport, None).await {
                Ok(info) => return Ok(info),
                Err(e) => {
                    if attempts.is_multiple_of(2) {
                        debug!("Local backend check attempt {attempts} failed: {e}");
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

pub async fn ensure_connectivity(
    manager: &BackendManager,
    transport: &dyn RcloneTransport,
    timeout: std::time::Duration,
) {
    let active_name = manager.get_active_name().await;

    if active_name == LOCAL_BACKEND_NAME {
        info!(
            "Checking Local backend for version/OS info (timeout: {}s)",
            timeout.as_secs()
        );
        match check_local_connectivity_retrying(manager, transport, timeout).await {
            Ok(_) => info!("Local backend is reachable and runtime info loaded"),
            Err(e) => {
                warn!(
                    "Local backend runtime-info fetch failed ({e}). \
                     Engine may still be healthy — UI will show version as unknown."
                );
                manager
                    .set_runtime_status(LOCAL_BACKEND_NAME, RuntimeStatus::Connected)
                    .await;
            }
        }
        return;
    }

    info!("Checking active backend: {active_name}");
    match probe_backend(manager, &active_name, transport, timeout).await {
        Ok(_) => info!("Active backend '{active_name}' is reachable"),
        Err(e) => warn!("Active backend '{active_name}' unreachable: {e}. Marked offline."),
    }
}
