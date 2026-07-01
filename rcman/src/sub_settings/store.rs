use crate::error::Result;
use serde_json::Value;

/// Storage abstraction for sub-settings
pub trait SubSettingsStore: Send + Sync {
    /// Get an entry by key
    fn get(&self, key: &str) -> Result<Value>;

    /// Set an entry
    fn set(&self, key: &str, value: Value) -> Result<()>;

    /// Remove an entry
    fn remove(&self, key: &str) -> Result<()>;

    /// Check if an entry exists (without reading its content)
    fn exists(&self, key: &str) -> Result<bool>;

    /// List all keys
    fn list(&self) -> Result<Vec<String>>;

    /// Get all entries
    fn get_all(&self) -> Result<std::collections::HashMap<String, Value>>;

    /// Invalidate any internal cache
    fn invalidate_cache(&self);

    /// Base path (directory) of the store
    fn base_path(&self) -> std::path::PathBuf;

    /// Single file path if applicable (returns `None` for multi-file stores)
    fn single_file_path(&self) -> Option<std::path::PathBuf>;
}
