use crate::rclone::backend::{BackendManager, RcloneTransport};
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

pub async fn check_local_connectivity_retrying(
    manager: &BackendManager,
    transport: &dyn RcloneTransport,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let check_local = async {
        let mut attempts = 0u32;
        loop {
            match check_connectivity(manager, "Local", transport, None).await {
                Ok(info) => return Ok(info),
                Err(e) => {
                    attempts += 1;
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
) -> Result<(), String> {
    let active_name = manager.get_active_name().await;

    if active_name == "Local" {
        info!(
            "Checking Local backend for version/OS info (timeout: {}s)",
            timeout.as_secs()
        );
        return if check_local_connectivity_retrying(manager, transport, timeout)
            .await
            .is_ok()
        {
            info!("Local backend is reachable and runtime info loaded");
            Ok(())
        } else {
            warn!(
                "Local backend timed out after {}s. Marking connected; runtime info may be missing.",
                timeout.as_secs()
            );
            manager
                .set_runtime_status(
                    "Local",
                    crate::rclone::backend::runtime::RuntimeStatus::Connected,
                )
                .await;
            Ok(())
        };
    }

    info!(
        "Checking active backend: {} (timeout: {}s)",
        active_name,
        timeout.as_secs()
    );

    match check_connectivity_with_timeout(manager, &active_name, transport, timeout).await {
        Ok(_) => {
            info!("Active backend '{active_name}' is reachable");
            Ok(())
        }
        Err(e) => {
            warn!("Active backend '{active_name}' unreachable: {e}. Marking offline.");
            manager
                .set_runtime_status(
                    &active_name,
                    crate::rclone::backend::runtime::RuntimeStatus::Error(e),
                )
                .await;
            Ok(())
        }
    }
}

pub async fn check_other_backends(manager: &BackendManager, transport: &dyn RcloneTransport) {
    let backends = manager.list_all().await;
    let active_name = manager.get_active_name().await;

    let tasks = backends
        .iter()
        .filter(|b| b.name != active_name && b.name != "Local")
        .map(|backend| {
            let name = &backend.name;
            async move {
                info!("Background check for backend: {name}");
                match check_connectivity(manager, name, transport, None).await {
                    Ok(_) => info!("Backend '{name}' is reachable"),
                    Err(e) => {
                        warn!("Backend '{name}' unreachable: {e}");
                        manager
                            .set_runtime_status(
                                name,
                                crate::rclone::backend::runtime::RuntimeStatus::Error(e),
                            )
                            .await;
                    }
                }
            }
        });

    futures::future::join_all(tasks).await;
}
