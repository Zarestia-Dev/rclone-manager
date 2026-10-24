use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

pub const OPTIONS_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub struct OptionsCacheEntry {
    pub backend_name: String,
    pub cached_at: Instant,
    pub payload: Value,
}

#[derive(Debug, Default)]
pub struct OptionsCache {
    entry: RwLock<Option<Arc<OptionsCacheEntry>>>,
}

impl OptionsCache {
    pub fn new() -> Self {
        Self {
            entry: RwLock::new(None),
        }
    }

    pub async fn get(&self, active_name: &str) -> Option<Value> {
        let entry = self.entry.read().await.clone()?;
        if entry.backend_name == active_name && entry.cached_at.elapsed() < OPTIONS_CACHE_TTL {
            return Some(entry.payload.clone());
        }
        None
    }

    pub async fn set(&self, backend_name: String, payload: Value) {
        *self.entry.write().await = Some(Arc::new(OptionsCacheEntry {
            backend_name,
            cached_at: Instant::now(),
            payload,
        }));
    }

    pub async fn get_entry(&self) -> Option<Arc<OptionsCacheEntry>> {
        self.entry.read().await.clone()
    }

    pub async fn set_entry(&self, entry: Option<Arc<OptionsCacheEntry>>) {
        *self.entry.write().await = entry;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_options_cache() {
        let cache = OptionsCache::new();
        let payload = json!({"test": "data"});

        // Cache is initially empty
        assert!(cache.get("backend1").await.is_none());

        // Set cache for backend1
        cache.set("backend1".to_string(), payload.clone()).await;

        // Get cache for backend1 (success)
        assert_eq!(cache.get("backend1").await, Some(payload.clone()));

        // Get cache for backend2 (none, isolation)
        assert!(cache.get("backend2").await.is_none());

        // Clear and restore through the same entry API used by backend switching.
        let saved = cache.get_entry().await.unwrap();
        let cached_at = saved.cached_at;
        cache.set_entry(None).await;
        assert!(cache.get("backend1").await.is_none());
        assert!(cache.get_entry().await.is_none());
        cache.set_entry(Some(saved)).await;
        assert_eq!(cache.get("backend1").await, Some(payload));
        assert!(cache.get("backend2").await.is_none());
        assert_eq!(cache.get_entry().await.unwrap().cached_at, cached_at);
    }

    #[tokio::test]
    async fn test_options_cache_expiry() {
        let cache = OptionsCache::new();
        let payload = json!({"test": "data"});

        // Manually set an expired entry
        let expired_entry = OptionsCacheEntry {
            backend_name: "backend1".to_string(),
            cached_at: Instant::now() - OPTIONS_CACHE_TTL - Duration::from_secs(1),
            payload: payload.clone(),
        };
        cache.set_entry(Some(Arc::new(expired_entry))).await;

        // Should return None due to expiry
        assert!(cache.get("backend1").await.is_none());
    }

    #[tokio::test]
    async fn snapshots_share_storage_but_returned_values_and_later_updates_are_independent() {
        let cache = OptionsCache::new();
        let original = json!({
            "main": [{"Name": "Belgeler & Arşiv", "Value": false, "Count": 0, "Nested": {"Rules": []}}]
        });
        cache.set("NAS".into(), original.clone()).await;
        let first = cache.get_entry().await.unwrap();
        let second = cache.get_entry().await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        let mut response = cache.get("NAS").await.unwrap();
        response["main"][0]["Value"] = json!(true);
        assert_eq!(first.payload, original);
        assert_eq!(cache.get("NAS").await, Some(original));

        cache.set("NAS".into(), json!({"main": []})).await;
        let replacement = cache.get_entry().await.unwrap();
        assert!(!Arc::ptr_eq(&first, &replacement));
        assert_eq!(first.payload["main"][0]["Value"], false);
        assert_eq!(replacement.payload, json!({"main": []}));
    }

    #[tokio::test]
    async fn option_loading_keeps_the_captured_backend_during_a_switch() {
        use crate::context::AppHandle;
        use crate::rclone::{
            backend::{BackendManager, routing_transport::RoutingTransport, types::Backend},
            queries::flags::get_all_options_with_values,
        };
        use crate::services::settings::{AppSettingsManager, schema::AppSettings};
        use crate::utils::types::state::RcloneState;
        use std::sync::atomic::AtomicBool;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager = rcman::SettingsManager::builder("options-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
            .build()
            .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("NAS", "127.0.0.1", listener.local_addr().unwrap().port()),
                None,
                None,
            )
            .await
            .unwrap();
        manager
            .add(
                &settings,
                Backend::new_remote("Other", "127.0.0.1", 0),
                None,
                None,
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "NAS").await.unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(RcloneState {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            transport: Arc::new(RoutingTransport::new(app.clone())),
            is_shutting_down: AtomicBool::new(false),
            poller_running: AtomicBool::new(false),
            poller_visible: AtomicBool::new(false),
            initial_startup: AtomicBool::new(false),
            updater_running: AtomicBool::new(false),
            initialization_lock: tokio::sync::Mutex::new(()),
            vault_operation_lock: tokio::sync::Mutex::new(()),
        });
        let server = crate::utils::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (header_end, length, path) = loop {
                    assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
                    if let Some(index) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..index]);
                        let path = headers.split_whitespace().nth(1).unwrap().to_string();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (index + 4, length, path);
                    }
                };
                while request.len() < header_end + length {
                    assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
                }
                let response = match path.as_str() {
                    "/options/info" => {
                        json!({"main": [{"Name": "transfers", "FieldName": "Transfers"}]})
                    }
                    "/options/get" => json!({"main": {"Transfers": 7}}),
                    _ => panic!("unexpected options request: {path}"),
                }
                .to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            }
        });

        let manager = app.state::<BackendManager>();
        let cache_guard = manager.options_cache.entry.write().await;
        let mut query = Box::pin(tokio::task::unconstrained(get_all_options_with_values(app)));
        // Poll until the query has captured the backend and waits for the held cache lock.
        assert!(futures::poll!(query.as_mut()).is_pending());
        let mut switch = Box::pin(tokio::task::unconstrained(
            manager.switch_to(&settings, "Other"),
        ));
        // The switch holds the backend write lock and waits for the same cache lock.
        assert!(futures::poll!(switch.as_mut()).is_pending());
        drop(cache_guard);

        let result = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(query, switch)
        })
        .await;
        if !matches!(&result, Ok((Ok(_), Ok(())))) {
            server.abort();
        }
        let (response, switched) = result.unwrap();
        switched.unwrap();
        let response = response.expect("options must use the backend captured before the switch");
        server.await.unwrap();
        assert_eq!(response["main"][0]["Value"], 7);
        assert_eq!(response["main"][0]["ValueStr"], "7");
        assert_eq!(manager.options_cache.get("NAS").await, Some(response));
        assert_eq!(manager.get_active_name().await, "Other");
        assert!(manager.options_cache.get("Other").await.is_none());
    }
}
