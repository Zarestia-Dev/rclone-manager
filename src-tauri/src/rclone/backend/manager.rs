// Backend Manager - Central orchestrator for all rclone backends
//
// Manages multiple backend instances and tracks the active one.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{BackendStatus, RcloneBackend};

/// Central manager for all rclone backends
pub struct BackendManager {
    /// All registered backends by name
    backends: RwLock<HashMap<String, Arc<RwLock<RcloneBackend>>>>,
    /// Name of the currently active backend
    active_backend: RwLock<String>,
}

impl BackendManager {
    /// Create a new BackendManager with no backends
    pub fn new() -> Self {
        Self {
            backends: RwLock::new(HashMap::new()),
            active_backend: RwLock::new(String::new()),
        }
    }

    /// Create a BackendManager with a default local backend
    pub fn with_local_backend(name: impl Into<String>) -> Self {
        let name = name.into();
        let backend = RcloneBackend::new_local(&name);
        let mut backends = HashMap::new();
        backends.insert(name.clone(), Arc::new(RwLock::new(backend)));

        Self {
            backends: RwLock::new(backends),
            active_backend: RwLock::new(name),
        }
    }

    /// Get the active backend
    pub async fn get_active(&self) -> Option<Arc<RwLock<RcloneBackend>>> {
        let active_name = self.active_backend.read().await;
        let backends = self.backends.read().await;
        backends.get(&*active_name).cloned()
    }

    /// Get the active backend name
    pub async fn get_active_name(&self) -> String {
        self.active_backend.read().await.clone()
    }

    /// Get a specific backend by name
    pub async fn get(&self, name: &str) -> Option<Arc<RwLock<RcloneBackend>>> {
        let backends = self.backends.read().await;
        backends.get(name).cloned()
    }

    /// Switch to a different backend
    pub async fn switch_to(&self, name: &str) -> Result<(), String> {
        let backends = self.backends.read().await;
        if !backends.contains_key(name) {
            return Err(format!("Backend '{}' not found", name));
        }
        drop(backends);

        let mut active = self.active_backend.write().await;
        *active = name.to_string();
        Ok(())
    }

    /// Add a new backend
    pub async fn add_backend(&self, backend: RcloneBackend) -> Result<(), String> {
        let name = backend.name.clone();
        let mut backends = self.backends.write().await;

        if backends.contains_key(&name) {
            return Err(format!("Backend '{}' already exists", name));
        }

        backends.insert(name, Arc::new(RwLock::new(backend)));
        Ok(())
    }

    /// Update an existing backend
    pub async fn update_backend(&self, backend: RcloneBackend) -> Result<(), String> {
        let name = backend.name.clone();
        let mut backends = self.backends.write().await;

        if !backends.contains_key(&name) {
            return Err(format!("Backend '{}' not found", name));
        }

        backends.insert(name, Arc::new(RwLock::new(backend)));
        Ok(())
    }

    /// Remove a backend by name
    pub async fn remove_backend(&self, name: &str) -> Result<(), String> {
        let active = self.active_backend.read().await;
        if *active == name {
            return Err("Cannot remove the active backend".to_string());
        }
        drop(active);

        let mut backends = self.backends.write().await;
        if backends.remove(name).is_none() {
            return Err(format!("Backend '{}' not found", name));
        }
        Ok(())
    }

    /// List all backend names
    pub async fn list_names(&self) -> Vec<String> {
        let backends = self.backends.read().await;
        backends.keys().cloned().collect()
    }

    /// Update the status of a backend
    pub async fn set_status(&self, name: &str, status: BackendStatus) -> Result<(), String> {
        let backends = self.backends.read().await;
        let backend = backends
            .get(name)
            .ok_or_else(|| format!("Backend '{}' not found", name))?;

        let mut backend = backend.write().await;
        backend.status = status;
        Ok(())
    }

    /// Get the OAuth URL of the active backend (if local)
    pub async fn get_active_oauth_url(&self) -> Option<String> {
        let backend = self.get_active().await?;
        let backend = backend.read().await;
        backend.oauth_url()
    }
}

impl Default for BackendManager {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Global Backend Manager Instance
// =============================================================================

use once_cell::sync::Lazy;

/// Global backend manager instance
///
/// This provides centralized access to all rclone backends.
pub static BACKEND_MANAGER: Lazy<BackendManager> =
    Lazy::new(|| BackendManager::with_local_backend("Local"));

impl BackendManager {
    /// Load persistent connections from settings
    pub async fn load_connections(
        &self,
        manager: &rcman::SettingsManager<rcman::JsonStorage>,
    ) -> Result<(), String> {
        let connections = manager
            .sub_settings("connections")
            .map_err(|e| e.to_string())?;

        let keys = connections.list().map_err(|e| e.to_string())?;

        for key in keys {
            if let Ok(value) = connections.get_value(&key)
                && let Ok(mut backend) = serde_json::from_value::<RcloneBackend>(value)
            {
                // Set the name from the HashMap key (since it's skipped in serialization)
                backend.name = key.clone();

                // Load secrets from credential manager
                crate::rclone::commands::backend::load_backend_secrets(manager, &mut backend);

                // For Local backend, update the existing one with saved settings
                if backend.name == "Local" {
                    let _ = self.update_backend(backend).await;
                } else {
                    let _ = self.add_backend(backend).await;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::types::BackendType;

    #[tokio::test]
    async fn test_new_empty_manager() {
        let manager = BackendManager::new();
        assert_eq!(manager.count().await, 0);
        assert!(manager.get_active().await.is_none());
    }

    #[tokio::test]
    async fn test_with_local_backend() {
        let manager = BackendManager::with_local_backend("Local");

        assert_eq!(manager.count().await, 1);
        assert_eq!(manager.get_active_name().await, "Local");

        let active = manager.get_active().await.unwrap();
        let backend = active.read().await;
        assert_eq!(backend.backend_type, BackendType::Local);
    }

    #[tokio::test]
    async fn test_add_backend() {
        let manager = BackendManager::new();
        let backend = RcloneBackend::new_remote("NAS", "192.168.1.100", 51900);

        manager.add_backend(backend).await.unwrap();
        assert_eq!(manager.count().await, 1);

        let retrieved = manager.get("NAS").await.unwrap();
        let backend = retrieved.read().await;
        assert_eq!(backend.name, "NAS");
    }

    #[tokio::test]
    async fn test_add_duplicate_backend() {
        let manager = BackendManager::with_local_backend("Local");
        let duplicate = RcloneBackend::new_local("Local");

        let result = manager.add_backend(duplicate).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[tokio::test]
    async fn test_switch_to() {
        let manager = BackendManager::with_local_backend("Local");
        let remote = RcloneBackend::new_remote("NAS", "192.168.1.100", 51900);
        manager.add_backend(remote).await.unwrap();

        assert_eq!(manager.get_active_name().await, "Local");

        manager.switch_to("NAS").await.unwrap();
        assert_eq!(manager.get_active_name().await, "NAS");
    }

    #[tokio::test]
    async fn test_switch_to_nonexistent() {
        let manager = BackendManager::with_local_backend("Local");

        let result = manager.switch_to("DoesNotExist").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[tokio::test]
    async fn test_remove_backend() {
        let manager = BackendManager::with_local_backend("Local");
        let remote = RcloneBackend::new_remote("NAS", "192.168.1.100", 51900);
        manager.add_backend(remote).await.unwrap();

        manager.remove_backend("NAS").await.unwrap();
        assert_eq!(manager.count().await, 1);
        assert!(manager.get("NAS").await.is_none());
    }

    #[tokio::test]
    async fn test_remove_active_backend() {
        let manager = BackendManager::with_local_backend("Local");

        let result = manager.remove_backend("Local").await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("Cannot remove the active backend")
        );
    }

    #[tokio::test]
    async fn test_list_names() {
        let manager = BackendManager::with_local_backend("Local");
        let remote = RcloneBackend::new_remote("NAS", "192.168.1.100", 51900);
        manager.add_backend(remote).await.unwrap();

        let names = manager.list_names().await;
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"Local".to_string()));
        assert!(names.contains(&"NAS".to_string()));
    }

    #[tokio::test]
    async fn test_set_status() {
        let manager = BackendManager::with_local_backend("Local");

        manager
            .set_status("Local", BackendStatus::Connected)
            .await
            .unwrap();

        let backend = manager.get("Local").await.unwrap();
        let backend = backend.read().await;
        assert_eq!(backend.status, BackendStatus::Connected);
    }

    #[tokio::test]
    async fn test_get_active_oauth_url() {
        let manager = BackendManager::with_local_backend("Local");

        let url = manager.get_active_oauth_url().await;
        assert_eq!(url, Some("http://127.0.0.1:51901".to_string()));
    }

    #[tokio::test]
    async fn test_global_backend_manager() {
        // Test that BACKEND_MANAGER is accessible and has a local backend
        assert_eq!(BACKEND_MANAGER.get_active_name().await, "Local");
        assert_eq!(BACKEND_MANAGER.count().await, 1);
    }
}
