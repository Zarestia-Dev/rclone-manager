//! Event system for settings changes
//!
//! Provides reactive callbacks for settings modifications.

use crate::utils::sync::RwLockExt;
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
    #[must_use]
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
    /// * `callback` - Function receiving (`full_key`, `old_value`, `new_value`)
    pub fn on_change<F>(&self, callback: F)
    where
        F: Fn(&str, &Value, &Value) + Send + Sync + 'static,
    {
        if let Ok(mut guard) = self.global_listeners.write_recovered() {
            guard.push(Arc::new(callback));
        } else {
            log::warn!("Failed to register global change listener due to lock recovery error");
        }
    }

    /// Register a listener for a specific setting key
    ///
    /// # Arguments
    /// * `key` - The setting key (e.g., "`general.dark_mode`")
    /// * `callback` - Function receiving (`full_key`, `old_value`, `new_value`)
    pub fn watch<F>(&self, key: &str, callback: F)
    where
        F: Fn(&str, &Value, &Value) + Send + Sync + 'static,
    {
        if let Ok(mut listeners) = self.key_listeners.write_recovered() {
            listeners
                .entry(key.to_string())
                .or_default()
                .push(Arc::new(callback));
        } else {
            log::warn!(
                "Failed to register key-specific listener for {key} due to lock recovery error"
            );
        }
    }

    /// Register a validator for a specific setting key
    ///
    /// Validators are called before saving. If any validator returns an error,
    /// the save is rejected.
    ///
    /// # Arguments
    /// * `key` - The setting key (e.g., "`general.dark_mode`")
    /// * `validator` - Function receiving the candidate value
    pub fn add_validator<F>(&self, key: &str, validator: F)
    where
        F: Fn(&Value) -> Result<(), String> + Send + Sync + 'static,
    {
        if let Ok(mut validators) = self.validators.write_recovered() {
            validators
                .entry(key.to_string())
                .or_default()
                .push(Arc::new(validator));
        } else {
            log::warn!("Failed to register validator for {key} due to lock recovery error");
        }
    }

    /// Validate a value before saving
    ///
    /// Returns Ok(()) if all validators pass, or Err with the first error message.
    ///
    /// # Errors
    ///
    /// Returns the first validation error message if any validator fails.
    pub fn validate(&self, key: &str, value: &Value) -> Result<(), String> {
        let guard = self.validators.read_recovered().map_err(|err| {
            log::warn!("Failed to validate {key} due to lock recovery error: {err}");
            "Internal lock error".to_string()
        })?;
        if let Some(validators) = guard.get(key) {
            for validator in validators {
                validator(value)?;
            }
        }
        Ok(())
    }

    /// Notify all listeners about a change
    ///
    /// # Arguments
    /// * `key` - The setting key (e.g., "`general.dark_mode`")
    /// * `old_value` - The old value
    /// * `new_value` - The new value
    pub fn notify(&self, key: &str, old_value: &Value, new_value: &Value) {
        // Call global listeners
        if let Ok(guard) = self.global_listeners.read_recovered() {
            for callback in guard.iter() {
                callback(key, old_value, new_value);
            }
        } else {
            log::warn!("Failed to read global listeners for {key} due to lock recovery error");
        }

        // Call key-specific listeners
        if let Ok(guard) = self.key_listeners.read_recovered() {
            if let Some(listeners) = guard.get(key) {
                for callback in listeners {
                    callback(key, old_value, new_value);
                }
            }
        } else {
            log::warn!(
                "Failed to read key-specific listeners for {key} due to lock recovery error"
            );
        }
    }

    /// Remove all listeners for a specific key
    pub fn unwatch(&self, key: &str) {
        if let Ok(mut guard) = self.key_listeners.write_recovered() {
            guard.remove(key);
        } else {
            log::warn!("Failed to remove listeners for {key} due to lock recovery error");
        }
    }

    /// Clear all listeners
    pub fn clear(&self) {
        if let Ok(mut guard) = self.global_listeners.write_recovered() {
            guard.clear();
        } else {
            log::warn!("Failed to clear global listeners due to lock recovery error");
        }
        if let Ok(mut guard) = self.key_listeners.write_recovered() {
            guard.clear();
        } else {
            log::warn!("Failed to clear key-specific listeners due to lock recovery error");
        }
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
    use std::panic::{AssertUnwindSafe, catch_unwind};
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

        events.watch("ui.theme", move |_key, _old, _new| {
            counter_clone.fetch_add(1, Ordering::SeqCst);
        });

        // This should trigger the listener
        events.notify("ui.theme", &json!("light"), &json!("dark"));

        // This should NOT trigger the listener
        events.notify("general.language", &json!("en"), &json!("tr"));

        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_validator() {
        let events = EventManager::new();

        // Add a validator that only accepts positive numbers
        events.add_validator("network.port", |value| {
            if let Some(n) = value.as_i64()
                && n > 0
                && n <= 65535
            {
                return Ok(());
            }
            Err("Port must be between 1 and 65535".into())
        });

        // Valid value
        assert!(events.validate("network.port", &json!(8080)).is_ok());

        // Invalid values
        assert!(events.validate("network.port", &json!(-1)).is_err());
        assert!(events.validate("network.port", &json!(70000)).is_err());
        assert!(
            events
                .validate("network.port", &json!("not a number"))
                .is_err()
        );

        // Unvalidated key should always pass
        assert!(events.validate("other", &json!("anything")).is_ok());
    }

    #[test]
    fn test_handles_poisoned_locks_without_panicking() {
        let events = EventManager::new();

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = events.global_listeners.write().unwrap();
            panic!("poison global listeners lock");
        }));

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = events.key_listeners.write().unwrap();
            panic!("poison key listeners lock");
        }));

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = events.validators.write().unwrap();
            panic!("poison validators lock");
        }));

        events.on_change(|_key, _old, _new| {});
        events.watch("ui.theme", |_key, _old, _new| {});
        events.add_validator("ui.theme", |_value| Ok(()));
        events.notify("ui.theme", &json!("old"), &json!("new"));
        events.unwatch("ui.theme");
        events.clear();

        assert!(events.validate("ui.theme", &json!("dark")).is_ok());
    }
}
