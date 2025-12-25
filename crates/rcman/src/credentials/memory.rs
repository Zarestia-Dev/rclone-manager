//! In-memory credential backend for testing

use super::CredentialBackend;
use crate::error::Result;
use std::collections::HashMap;
use std::sync::RwLock;

/// In-memory credential storage (not persisted)
pub struct MemoryBackend {
    store: RwLock<HashMap<String, String>>,
}

impl MemoryBackend {
    /// Create a new memory backend
    pub fn new() -> Self {
        Self {
            store: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for MemoryBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialBackend for MemoryBackend {
    fn store(&self, key: &str, value: &str) -> Result<()> {
        if let Ok(mut store) = self.store.write() {
            store.insert(key.to_string(), value.to_string());
        }
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.store.read().ok().and_then(|s| s.get(key).cloned()))
    }

    fn remove(&self, key: &str) -> Result<()> {
        if let Ok(mut store) = self.store.write() {
            store.remove(key);
        }
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<String>> {
        Ok(self
            .store
            .read()
            .map(|s| s.keys().cloned().collect())
            .unwrap_or_default())
    }

    fn backend_name(&self) -> &'static str {
        "memory"
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_store_and_get() {
        let backend = MemoryBackend::new();

        backend.store("key1", "value1").unwrap();
        backend.store("key2", "value2").unwrap();

        assert_eq!(backend.get("key1").unwrap(), Some("value1".to_string()));
        assert_eq!(backend.get("key2").unwrap(), Some("value2".to_string()));
        assert_eq!(backend.get("key3").unwrap(), None);
    }

    #[test]
    fn test_memory_remove() {
        let backend = MemoryBackend::new();

        backend.store("key", "value").unwrap();
        assert!(backend.exists("key").unwrap());

        backend.remove("key").unwrap();
        assert!(!backend.exists("key").unwrap());
    }

    #[test]
    fn test_memory_list_keys() {
        let backend = MemoryBackend::new();

        backend.store("a", "1").unwrap();
        backend.store("b", "2").unwrap();

        let mut keys = backend.list_keys().unwrap();
        keys.sort();
        assert_eq!(keys, vec!["a", "b"]);
    }
}
