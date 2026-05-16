use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

pub const OPTIONS_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct OptionsCacheEntry {
    pub backend_name: String,
    pub cached_at: Instant,
    pub payload: Value,
}

#[derive(Debug, Default)]
pub struct OptionsCache {
    entry: RwLock<Option<OptionsCacheEntry>>,
}

impl OptionsCache {
    pub fn new() -> Self {
        Self {
            entry: RwLock::new(None),
        }
    }

    pub async fn get(&self, active_name: &str) -> Option<Value> {
        let cache = self.entry.read().await;
        if let Some(entry) = cache.as_ref()
            && entry.backend_name == active_name
            && entry.cached_at.elapsed() < OPTIONS_CACHE_TTL
        {
            return Some(entry.payload.clone());
        }
        None
    }

    pub async fn set(&self, backend_name: String, payload: Value) {
        *self.entry.write().await = Some(OptionsCacheEntry {
            backend_name,
            cached_at: Instant::now(),
            payload,
        });
    }

    pub async fn clear(&self) {
        *self.entry.write().await = None;
    }

    pub async fn get_entry(&self) -> Option<OptionsCacheEntry> {
        self.entry.read().await.clone()
    }

    pub async fn set_entry(&self, entry: Option<OptionsCacheEntry>) {
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

        // Clear cache
        cache.clear().await;
        assert!(cache.get("backend1").await.is_none());
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
        cache.set_entry(Some(expired_entry)).await;

        // Should return None due to expiry
        assert!(cache.get("backend1").await.is_none());
    }
}
