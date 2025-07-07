use crate::utils::types::NetworkStatusPayload;
use log::{debug, error, info};
use std::collections::HashMap;
use tauri::Emitter;
use tauri::command;

use crate::utils::types::{CheckResult, LinkChecker};

#[command]
pub async fn check_links(
    links: String,
    max_retries: usize,
    retry_delay_secs: u64,
) -> Result<CheckResult, String> {
    let checker = LinkChecker::new(max_retries, retry_delay_secs);
    checker.check_links(&links).await.map_err(|e| e.to_string())
}

impl LinkChecker {
    fn new(max_retries: usize, retry_delay_secs: u64) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            max_retries,
            retry_delay: std::time::Duration::from_secs(retry_delay_secs),
        }
    }

    async fn check_links(&self, links: &str) -> Result<CheckResult, Box<dyn std::error::Error>> {
        let links_vec: Vec<String> = links
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        let successful = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let failed = std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let retries_used = std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        let mut handles = vec![];

        for link in links_vec {
            let checker = self.client.clone();
            let max_retries = self.max_retries;
            let retry_delay = self.retry_delay;
            let successful = successful.clone();
            let failed = failed.clone();
            let retries_used = retries_used.clone();

            handles.push(tokio::spawn(async move {
                let mut last_error = None;
                let mut retries = 0;

                while retries <= max_retries {
                    match checker.get(&link).send().await {
                        Ok(response) => {
                            if response.status().is_success() {
                                successful.lock().await.push(link.clone());
                                retries_used.lock().await.insert(link.clone(), retries);
                                return;
                            } else {
                                last_error = Some(format!("HTTP status: {}", response.status()));
                            }
                        }
                        Err(e) => {
                            last_error = Some(e.to_string());
                        }
                    }

                    if retries < max_retries {
                        tokio::time::sleep(retry_delay).await;
                    }
                    retries += 1;
                }

                failed.lock().await.insert(
                    link.clone(),
                    last_error.unwrap_or_else(|| "Unknown error".to_string()),
                );
                retries_used.lock().await.insert(link.clone(), retries - 1);
            }));
        }

        // Wait for all tasks to complete
        for handle in handles {
            let _ = handle.await;
        }

        let successful = successful.lock().await.clone();
        let failed = failed.lock().await.clone();
        let retries_used = retries_used.lock().await.clone();

        Ok(CheckResult {
            successful,
            failed,
            retries_used,
        })
    }
}

#[cfg(target_os = "linux")]
pub fn is_metered() -> bool {
    use zbus::blocking::{Connection, Proxy};

    let connection = Connection::system().unwrap();
    let proxy = Proxy::new(
        &connection,
        "org.freedesktop.NetworkManager",
        "/org/freedesktop/NetworkManager",
        "org.freedesktop.NetworkManager",
    )
    .unwrap();

    // The Metered property returns an enum:
    // 0: Unknown, 1: Yes, 2: No, 3: Guess-Yes, 4: Guess-No
    let metered_status: u32 = proxy.get_property("Metered").unwrap();

    matches!(metered_status, 1 | 3)
}

// Make sure you have these `use` statements for the Linux implementation
#[cfg(target_os = "linux")]
use {futures_lite::stream::StreamExt, zbus::Connection};

#[cfg(target_os = "linux")]
pub async fn monitor_network_changes(app_handle: tauri::AppHandle) {
    let connection = match Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to connect to D-Bus: {e}");
            return;
        }
    };

    let proxy = zbus::Proxy::new(
        &connection,
        "org.freedesktop.NetworkManager",
        "/org/freedesktop/NetworkManager",
        "org.freedesktop.NetworkManager",
    )
    .await
    .unwrap();

    // Listen for changes to the "Metered" property.
    let mut metered_changed_stream = proxy.receive_property_changed::<u32>("Metered").await;
    info!("Listening for NetworkManager 'Metered' property changes...");

    while let Some(_metered_status) = metered_changed_stream.next().await {
        debug!("'Metered' property changed!");

        let payload = NetworkStatusPayload {
            is_metered: is_metered(),
        };
        app_handle.emit("network-status-changed", payload).unwrap();
    }
}

#[cfg(target_os = "macos")]
pub fn is_metered() -> bool {
    // macOS does not support metered network detection.
    // Always return false.
    info!("is_metered: macOS does not support metered network detection, returning false.");
    false
}

#[cfg(target_os = "macos")]
pub async fn monitor_network_changes(app_handle: tauri::AppHandle) {
    // Always emit is_metered: false, since macOS does not support metered detection.
    let payload = NetworkStatusPayload { is_metered: false };
    app_handle.emit("network-status-changed", payload).unwrap();

    // Optionally, you can skip the loop entirely, or just sleep forever.
    // loop { tokio::time::sleep(std::time::Duration::from_secs(3600)).await; }
}

#[cfg(windows)]
pub fn is_metered() -> bool {
    use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};

    let profile = NetworkInformation::GetInternetConnectionProfile().unwrap();
    let cost = profile.GetConnectionCost().unwrap();

    matches!(
        cost.NetworkCostType().unwrap(),
        NetworkCostType::Fixed | NetworkCostType::Variable
    )
}

#[cfg(windows)]
pub async fn monitor_network_changes(app_handle: tauri::AppHandle) {
    use windows::Networking::Connectivity::{NetworkInformation, NetworkStatusChangedEventHandler};

    let handler = NetworkStatusChangedEventHandler::new(move |_| {
        let payload = NetworkStatusPayload {
            is_metered: is_metered(),
        };
        app_handle.emit("network-status-changed", payload).unwrap();
        Ok(())
    });

    let _token = NetworkInformation::NetworkStatusChanged(&handler).unwrap();
}

#[tauri::command]
pub fn is_network_metered() -> bool {
    #[cfg(target_os = "linux")]
    return is_metered();

    #[cfg(windows)]
    return is_metered();

    #[cfg(target_os = "macos")]
    return is_metered();

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    return false; // Default for unsupported platforms
}
