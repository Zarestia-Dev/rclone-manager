use std::collections::HashMap;

use crate::core::bridge;

use crate::utils::types::rclone::CheckResult;

#[cfg(not(target_os = "ios"))]
use crate::utils::types::events::NETWORK_STATUS_CHANGED;
#[cfg(not(target_os = "ios"))]
use crate::utils::types::monitoring::NetworkStatusPayload;

#[bridge]
pub async fn check_links(
    links: Vec<String>,
    max_retries: usize,
    retry_delay_secs: u64,
) -> Result<CheckResult, String> {
    let checker = LinkChecker::new(max_retries, retry_delay_secs);
    checker.check_links(&links).await.map_err(|e| e.to_string())
}

pub struct LinkChecker {
    pub client: reqwest::Client,
    pub max_retries: usize,
    pub retry_delay: std::time::Duration,
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

    async fn check_links(
        &self,
        links: &[String],
    ) -> Result<CheckResult, Box<dyn std::error::Error>> {
        let links_vec = links.to_vec();

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
                            }
                            last_error = Some(format!("HTTP status: {}", response.status()));
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

#[cfg(all(target_os = "linux", not(feature = "container")))]
#[must_use]
pub fn is_metered() -> bool {
    std::thread::spawn(|| {
        use zbus::blocking::{Connection, Proxy};

        let connection = match Connection::system() {
            Ok(c) => c,
            Err(e) => {
                log::error!("Failed to connect to D-Bus: {e}");
                return false;
            }
        };

        let proxy = match Proxy::new(
            &connection,
            "org.freedesktop.NetworkManager",
            "/org/freedesktop/NetworkManager",
            "org.freedesktop.NetworkManager",
        ) {
            Ok(p) => p,
            Err(e) => {
                log::error!("NetworkManager D-Bus proxy error: {e}");
                return false;
            }
        };

        match proxy.get_property::<u32>("Metered") {
            Ok(status) => matches!(status, 1 | 3),
            Err(e) => {
                log::error!("Failed to read Metered property: {e}");
                false
            }
        }
    })
    .join()
    .unwrap_or(false)
}

#[cfg(all(target_os = "linux", not(feature = "container")))]
use {futures_lite::stream::StreamExt, zbus::Connection};

#[cfg(all(target_os = "linux", not(feature = "container")))]
pub async fn monitor_network_changes(app_handle: tauri::AppHandle) {
    let connection = match Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to connect to D-Bus: {e}");
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
            log::error!("Failed to create NetworkManager D-Bus proxy: {e}");
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

        if let Err(e) = tauri::Emitter::emit(&app_handle, NETWORK_STATUS_CHANGED, payload) {
            log::error!("Failed to emit network status change event: {e}");
        }
    }
}

#[cfg(all(target_os = "linux", feature = "container"))]
#[must_use]
pub fn is_metered() -> bool {
    log::info!(
        "is_metered: container mode does not support metered network detection, returning false."
    );
    false
}

#[cfg(any(target_os = "macos", all(target_os = "linux", feature = "container")))]
pub async fn monitor_network_changes(app_handle: tauri::AppHandle) {
    use tauri::Emitter;
    let payload = NetworkStatusPayload { is_metered: false };
    if let Err(e) = app_handle.emit(NETWORK_STATUS_CHANGED, payload) {
        log::error!("Failed to emit network status change event: {e}");
    }
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
pub async fn monitor_network_changes(app_handle: tauri::AppHandle) {
    use tauri::Emitter;
    use windows::Networking::Connectivity::{NetworkInformation, NetworkStatusChangedEventHandler};

    let handler = NetworkStatusChangedEventHandler::new(move |_| {
        let payload = NetworkStatusPayload {
            is_metered: is_metered(),
        };
        if let Err(e) = app_handle.emit(NETWORK_STATUS_CHANGED, payload) {
            log::error!("Failed to emit network status change event: {e}");
        }
        Ok(())
    });

    if let Err(e) = NetworkInformation::NetworkStatusChanged(&handler) {
        log::error!("Failed to register network status changed handler: {e}");
    }
}

#[cfg(target_os = "android")]
#[must_use]
pub fn is_metered() -> bool {
    use jni::{jni_sig, jni_str};

    let ctx = ndk_context::android_context();
    let vm_ptr = ctx.vm();
    let context_ptr = ctx.context();
    if vm_ptr.is_null() || context_ptr.is_null() {
        log::warn!("is_metered: Android context or VM pointer is null");
        return false;
    }

    let vm = unsafe { jni::JavaVM::from_raw(vm_ptr.cast()) };
    let res: Result<bool, jni::errors::Error> = vm.attach_current_thread(|env| {
        let context_obj = unsafe { jni::objects::JObject::from_raw(env, context_ptr.cast()) };

        let service_name = env.new_string("connectivity")?;

        let cm_val = env.call_method(
            &context_obj,
            jni_str!("getSystemService"),
            jni_sig!("(Ljava/lang/String;)Ljava/lang/Object;"),
            &[jni::objects::JValue::Object(&service_name)],
        )?;
        let cm = cm_val.l()?;

        if cm.is_null() {
            return Ok(false);
        }

        let metered_val = env.call_method(
            &cm,
            jni_str!("isActiveNetworkMetered"),
            jni_sig!("()Z"),
            &[],
        )?;

        Ok(metered_val.z().unwrap_or(false))
    });

    match res {
        Ok(val) => val,
        Err(e) => {
            log::error!("is_metered: JNI error: {e}");
            false
        }
    }
}

#[cfg(target_os = "android")]
pub async fn monitor_network_changes(app_handle: tauri::AppHandle) {
    use tauri::Emitter;
    use tokio::time::{Duration, sleep};

    let mut last_metered = is_metered();
    log::info!("Starting Android network status monitor (initial metered: {last_metered})");

    loop {
        sleep(Duration::from_secs(5)).await;
        let current_metered = is_metered();
        if current_metered != last_metered {
            log::info!(
                "Android metered network status changed: {last_metered} -> {current_metered}"
            );
            last_metered = current_metered;
            let payload = NetworkStatusPayload {
                is_metered: current_metered,
            };
            if let Err(e) = app_handle.emit(NETWORK_STATUS_CHANGED, payload) {
                log::error!("Failed to emit network status change event: {e}");
            }
        }
    }
}

#[bridge]
pub async fn is_network_metered() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    return Ok(is_metered());

    #[cfg(windows)]
    return Ok(is_metered());

    #[cfg(target_os = "macos")]
    return Ok(is_metered());

    #[cfg(target_os = "android")]
    return Ok(is_metered());

    #[cfg(not(any(
        windows,
        target_os = "linux",
        target_os = "macos",
        target_os = "android"
    )))]
    return Ok(false); // Default for unsupported platforms
}
