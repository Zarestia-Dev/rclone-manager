//! Event system for settings changes
//!
//! Provides reactive callbacks for settings modifications.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::RwLock;

/// Type alias for a change callback
pub type ChangeCallback = Arc<dyn Fn(&str, &Value, &Value) + Send + Sync>;

/// Type alias for a validator function
pub type Validator = Arc<dyn Fn(&Value) -> Result<(), String> + Send + Sync>;

/// Manages event listeners for settings changes
pub struct EventManager {
    /// Global listeners (called for all changes)
    global_listeners: RwLock<Vec<ChangeCallback>>,

    /// Per-key listeners (called only for specific setting changes)
    key_listeners: RwLock<HashMap<String, Vec<ChangeCallback>>>,

    /// Validators per key
    validators: RwLock<HashMap<String, Vec<Validator>>>,
}

impl EventManager {
    /// Create a new event manager
    pub fn new() -> Self {
        Self {
            global_listeners: RwLock::new(Vec::new()),
            key_listeners: RwLock::new(HashMap::new()),
            validators: RwLock::new(HashMap::new()),
        }
    }

    /// Register a global change listener (called for all settings changes)
    ///
    /// # Arguments
    /// * `callback` - Function receiving (full_key, old_value, new_value)
    pub fn on_change<F>(&self, callback: F)
    where
        F: Fn(&str, &Value, &Value) + Send + Sync + 'static,
    {
        let mut guard = self.global_listeners.write().unwrap();
        guard.push(Arc::new(callback));
    }

    /// Register a listener for a specific setting key
    ///
    /// # Arguments
    /// * `key` - The setting key (e.g., "general.dark_mode")
    /// * `callback` - Function receiving (full_key, old_value, new_value)
    pub fn watch<F>(&self, key: &str, callback: F)
    where
        F: Fn(&str, &Value, &Value) + Send + Sync + 'static,
    {
        let mut listeners = self.key_listeners.write().unwrap();
        listeners
            .entry(key.to_string())
            .or_default()
            .push(Arc::new(callback));
    }

    /// Register a validator for a specific setting key
    ///
    /// Validators are called before saving. If any validator returns an error,
    /// the save is rejected.
    pub fn add_validator<F>(&self, key: &str, validator: F)
    where
        F: Fn(&Value) -> Result<(), String> + Send + Sync + 'static,
    {
        let mut validators = self.validators.write().unwrap();
        validators
            .entry(key.to_string())
            .or_default()
            .push(Arc::new(validator));
    }

    /// Validate a value before saving
    ///
    /// Returns Ok(()) if all validators pass, or Err with the first error message.
    pub fn validate(&self, key: &str, value: &Value) -> Result<(), String> {
        let guard = self.validators.read().unwrap();
        if let Some(validators) = guard.get(key) {
            for validator in validators {
                validator(value)?;
            }
        }
        Ok(())
    }

    /// Notify all listeners about a change
    pub fn notify(&self, key: &str, old_value: &Value, new_value: &Value) {
        // Call global listeners
        {
            let guard = self.global_listeners.read().unwrap();
            for callback in guard.iter() {
                callback(key, old_value, new_value);
            }
        }

        // Call key-specific listeners
        {
            let guard = self.key_listeners.read().unwrap();
            if let Some(listeners) = guard.get(key) {
                for callback in listeners {
                    callback(key, old_value, new_value);
                }
            }
        }
    }

    /// Remove all listeners for a specific key
    pub fn unwatch(&self, key: &str) {
        let mut guard = self.key_listeners.write().unwrap();
        guard.remove(key);
    }

    /// Clear all listeners
    pub fn clear(&self) {
        self.global_listeners.write().unwrap().clear();
        self.key_listeners.write().unwrap().clear();
    }
}

impl Default for EventManager {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn test_global_listener() {
        let events = EventManager::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_clone = counter.clone();

        events.on_change(move |_key, _old, _new| {
            counter_clone.fetch_add(1, Ordering::SeqCst);
        });

        events.notify("test.key", &json!(null), &json!("value"));

        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_key_specific_listener() {
        let events = EventManager::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_clone = counter.clone();

        events.watch("theme", move |_key, _old, _new| {
            counter_clone.fetch_add(1, Ordering::SeqCst);
        });

        // This should trigger the listener
        events.notify("theme", &json!("light"), &json!("dark"));

        // This should NOT trigger the listener
        events.notify("language", &json!("en"), &json!("tr"));

        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_validator() {
        let events = EventManager::new();

        // Add a validator that only accepts positive numbers
        events.add_validator("port", |value| {
            if let Some(n) = value.as_i64() {
                if n > 0 && n <= 65535 {
                    return Ok(());
                }
            }
            Err("Port must be between 1 and 65535".into())
        });

        // Valid value
        assert!(events.validate("port", &json!(8080)).is_ok());

        // Invalid values
        assert!(events.validate("port", &json!(-1)).is_err());
        assert!(events.validate("port", &json!(70000)).is_err());
        assert!(events.validate("port", &json!("not a number")).is_err());

        // Unvalidated key should always pass
        assert!(events.validate("other", &json!("anything")).is_ok());
    }
}
