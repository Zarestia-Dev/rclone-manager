#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::collections::HashMap;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::utils::types::rclone::CheckResult;

#[cfg(not(target_os = "ios"))]
use crate::utils::types::events::NETWORK_STATUS_CHANGED;
#[cfg(not(target_os = "ios"))]
use crate::utils::types::monitoring::NetworkStatusPayload;

/// Checks that every link answers with a success status, retrying failures.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn check_links(
    links: Vec<String>,
    max_retries: usize,
    retry_delay_secs: u64,
) -> Result<CheckResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let retry_delay = std::time::Duration::from_secs(retry_delay_secs);

    let outcomes = futures::future::join_all(links.into_iter().map(|link| {
        let client = client.clone();
        async move {
            let mut last_error = None;
            for attempt in 0..=max_retries {
                match client.get(&link).send().await {
                    Ok(response) if response.status().is_success() => {
                        return (link, attempt, Ok(()));
                    }
                    Ok(response) => {
                        last_error = Some(format!("HTTP status: {}", response.status()))
                    }
                    Err(e) => last_error = Some(e.to_string()),
                }
                if attempt < max_retries {
                    tokio::time::sleep(retry_delay).await;
                }
            }
            let error = last_error.unwrap_or_else(|| "Unknown error".to_string());
            (link, max_retries, Err(error))
        }
    }))
    .await;

    let mut result = CheckResult {
        successful: Vec::new(),
        failed: HashMap::new(),
        retries_used: HashMap::new(),
    };
    for (link, retries, outcome) in outcomes {
        result.retries_used.insert(link.clone(), retries);
        match outcome {
            Ok(()) => result.successful.push(link),
            Err(error) => {
                result.failed.insert(link, error);
            }
        }
    }
    Ok(result)
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
#[must_use]
pub fn is_metered() -> bool {
    std::thread::spawn(|| {
        crate::utils::block_on(async {
            use zbus::{Connection, Proxy};

            let connection = match Connection::system().await {
                Ok(c) => c,
                Err(e) => {
                    log::debug!("Failed to connect to D-Bus for metered network check: {e}");
                    return false;
                }
            };

            let proxy = match Proxy::new(
                &connection,
                "org.freedesktop.NetworkManager",
                "/org/freedesktop/NetworkManager",
                "org.freedesktop.NetworkManager",
            )
            .await
            {
                Ok(p) => p,
                Err(e) => {
                    log::debug!("NetworkManager D-Bus proxy error: {e}");
                    return false;
                }
            };

            match proxy.get_property::<u32>("Metered").await {
                Ok(status) => matches!(status, 1 | 3),
                Err(e) => {
                    log::debug!("Failed to read Metered property: {e}");
                    false
                }
            }
        })
    })
    .join()
    .unwrap_or(false)
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
use {futures::StreamExt, zbus::Connection};

#[cfg(all(feature = "desktop", target_os = "linux"))]
pub async fn monitor_network_changes() {
    let connection = match Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            log::debug!("Failed to connect to D-Bus for network change monitoring: {e}");
            return;
        }
    };

    let proxy = match zbus::Proxy::new(
        &connection,
        "org.freedesktop.NetworkManager",
        "/org/freedesktop/NetworkManager",
        "org.freedesktop.NetworkManager",
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            log::debug!("Failed to create NetworkManager D-Bus proxy: {e}");
            return;
        }
    };

    let mut metered_changed_stream = proxy.receive_property_changed::<u32>("Metered").await;
    log::info!("Listening for NetworkManager 'Metered' property changes...");

    while let Some(_metered_status) = metered_changed_stream.next().await {
        log::debug!("'Metered' property changed!");
        let payload = NetworkStatusPayload {
            is_metered: is_metered(),
        };

        crate::services::bridge::emit(NETWORK_STATUS_CHANGED, payload);
    }
}

#[cfg(all(target_os = "linux", not(feature = "desktop")))]
#[must_use]
pub fn is_metered() -> bool {
    log::debug!(
        "is_metered: headless/server mode does not support metered network detection, returning false."
    );
    false
}

#[cfg(any(
    target_os = "macos",
    all(target_os = "linux", not(feature = "desktop"))
))]
pub async fn monitor_network_changes() {
    let payload = NetworkStatusPayload { is_metered: false };
    crate::services::bridge::emit(NETWORK_STATUS_CHANGED, payload);
}

#[cfg(target_os = "macos")]
pub fn is_metered() -> bool {
    // macOS does not support metered network detection.
    // Always return false.
    log::info!("is_metered: macOS does not support metered network detection, returning false.");
    false
}

#[cfg(windows)]
pub fn is_metered() -> bool {
    use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};

    let profile = match NetworkInformation::GetInternetConnectionProfile() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let cost = match profile.GetConnectionCost() {
        Ok(c) => c,
        Err(_) => return false,
    };

    matches!(
        cost.NetworkCostType()
            .unwrap_or(NetworkCostType::Unrestricted),
        NetworkCostType::Fixed | NetworkCostType::Variable
    )
}

#[cfg(windows)]
pub async fn monitor_network_changes() {
    use windows::Networking::Connectivity::{NetworkInformation, NetworkStatusChangedEventHandler};
    let handler = NetworkStatusChangedEventHandler::new(move |_| {
        let payload = NetworkStatusPayload {
            is_metered: is_metered(),
        };
        crate::services::bridge::emit(NETWORK_STATUS_CHANGED, payload);
        Ok(())
    });

    if let Err(e) = NetworkInformation::NetworkStatusChanged(&handler) {
        log::error!("Failed to register network status changed handler: {e}");
    }
}

#[cfg(target_os = "android")]
#[must_use]
pub fn is_metered() -> bool {
    crate::rclone::backend::saf_bridge::is_network_metered()
}

/// Android reports changes through a network callback, which calls [`on_metered_changed`].
#[cfg(target_os = "android")]
pub async fn monitor_network_changes() {
    if !crate::rclone::backend::saf_bridge::start_network_monitor() {
        log::warn!("Android network status monitor could not be started");
    }
}

/// Called from the Android network callback when the metered state changes.
#[cfg(target_os = "android")]
pub fn on_metered_changed(is_metered: bool) {
    log::info!("Android metered network status changed: {is_metered}");
    crate::services::bridge::emit(NETWORK_STATUS_CHANGED, NetworkStatusPayload { is_metered });
}

#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "macos",
    target_os = "android"
)))]
#[must_use]
pub fn is_metered() -> bool {
    false
}

pub async fn is_network_metered() -> Result<bool, String> {
    Ok(is_metered())
}

#[cfg(all(
    test,
    not(any(
        windows,
        target_os = "linux",
        target_os = "macos",
        target_os = "android"
    ))
))]
mod tests {
    #[tokio::test]
    async fn unsupported_platform_is_not_metered() {
        assert!(!super::is_network_metered().await.unwrap());
    }
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::check_links;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Answers `/ok` with 200 and everything else with 500.
    async fn serve() -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buffer = [0; 1024];
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    let ok = String::from_utf8_lossy(&buffer[..read]).starts_with("GET /ok ");
                    let status = if ok {
                        "200 OK"
                    } else {
                        "500 Internal Server Error"
                    };
                    let _ = socket
                        .write_all(
                            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                .as_bytes(),
                        )
                        .await;
                });
            }
        });
        address
    }

    #[tokio::test]
    async fn links_are_sorted_into_successful_and_failed_with_their_retries() {
        let address = serve().await;
        let ok = format!("http://{address}/ok");
        let bad = format!("http://{address}/bad");
        let result = check_links(vec![ok.clone(), bad.clone()], 2, 0)
            .await
            .unwrap();
        assert_eq!(result.successful, std::slice::from_ref(&ok));
        assert_eq!(
            result.failed[&bad],
            "HTTP status: 500 Internal Server Error"
        );
        assert_eq!(result.retries_used[&ok], 0);
        assert_eq!(result.retries_used[&bad], 2);
    }

    #[tokio::test]
    async fn no_links_means_an_empty_result() {
        let result = check_links(vec![], 3, 0).await.unwrap();
        assert!(result.successful.is_empty() && result.failed.is_empty());
    }
}
