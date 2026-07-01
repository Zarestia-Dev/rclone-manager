//! Environment variable handling for settings
//!
//! Helper struct to encapsulate logic for overriding settings via env vars.

use crate::config::EnvSource;
use serde_json::Value;

/// Handles environment variable lookups and parsing
pub struct EnvironmentHandler {
    prefix: Option<String>,
    source: std::sync::Arc<dyn EnvSource>,
}

impl EnvironmentHandler {
    pub fn new(prefix: Option<String>, source: std::sync::Arc<dyn EnvSource>) -> Self {
        Self { prefix, source }
    }

    /// Get the environment variable name for a setting key
    ///
    /// Returns None if env var overrides are disabled.
    /// Format: {PREFIX}_{CATEGORY}_{KEY} (all uppercase)
    pub fn get_env_var_name(&self, key: &str) -> Option<String> {
        self.prefix.as_ref().map(|prefix| {
            let env_key = key.replace('.', "_").to_uppercase();
            format!("{}_{}", prefix.to_uppercase(), env_key)
        })
    }

    /// Check if a setting value is overridden by an environment variable
    pub fn get_env_override(&self, key: &str) -> Option<Value> {
        let env_var_name = self.get_env_var_name(key)?;
        self.source.var(&env_var_name).ok().map(|env_value| {
            // Try to parse as JSON first, fallback to string/bool/number heuristics
            serde_json::from_str(&env_value).unwrap_or_else(|_| {
                if env_value.eq_ignore_ascii_case("true") {
                    Value::Bool(true)
                } else if env_value.eq_ignore_ascii_case("false") {
                    Value::Bool(false)
                } else if let Ok(n) = env_value.parse::<i64>() {
                    Value::Number(n.into())
                } else if let Ok(n) = env_value.parse::<f64>() {
                    serde_json::Number::from_f64(n)
                        .map_or_else(|| Value::String(env_value.clone()), Value::Number)
                } else {
                    Value::String(env_value)
                }
            })
        })
    }
}
