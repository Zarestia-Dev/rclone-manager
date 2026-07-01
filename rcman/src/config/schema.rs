//! Settings schema trait and metadata types
//!
//! # Overview
//!
//! This module provides a **flexible, type-safe metadata system** for settings management:
//!
//! - **Dynamic Metadata**: Store any custom key-value metadata on settings using `.meta_*()` methods
//! - **Type-Specific Constraints**: Separate structures for Number, Text constraints that are enforced
//! - **Framework-Agnostic**: No opinionated UI bindings - pure data structures
//! - **Type Safety at Construction**: Select type requires options at creation time
//!
//! # Architecture
//!
//! ## Static vs Dynamic Metadata
//!
//! `SettingMetadata` has two kinds of metadata:
//!
//! 1. **Type-Specific Constraints** (static fields):
//!    - `constraints.number` - min, max, step for Number type
//!    - `constraints.text` - pattern for Text type
//!    - `constraints.options` - Select options (REQUIRED for Select type)
//!
//! 2. **Custom Metadata** (`HashMap<String, Value>`):
//!    - Any developer-defined key-value pairs
//!    - Use string literals for your metadata keys (e.g., `"label"`, `"category"`, `"advanced"`)
//!    - **No predefined keys** - add whatever your framework/app needs!
//!
//! ```rust,no_run
//! use rcman::{SettingMetadata, opt};
//!
//! // Type-safe constraints at construction
//! let port = SettingMetadata::number(8080.0)
//!     .min(1024.0)                                    // <- constraint
//!     .max(65535.0)                                   // <- constraint
//!     .meta_str("label", "Server Port")              // <- custom metadata
//!     .meta_str("category", "network")               // <- custom metadata
//!     .meta_bool("requires_restart", true);          // <- custom metadata
//!
//! // Select requires options at construction
//! let theme = SettingMetadata::select("dark", vec![
//!     opt("light", "Light Theme"),
//!     opt("dark", "Dark Theme"),
//! ])
//! .meta_str("label", "Theme")
//! .meta_num("order", 1);
//! ```
//!
//! # Dynamic Metadata API
//!
//! Add any custom metadata to settings:
//!
//! ```rust,no_run
//! use rcman::SettingMetadata;
//! use serde_json::json;
//!
//! let setting = SettingMetadata::text("default")
//!     .meta_str("label", "My Label")              // String metadata
//!     .meta_str("description", "Help text")       // String metadata
//!     .meta_str("category", "general")            // String metadata
//!     .meta_bool("advanced", true)                // Boolean metadata
//!     .meta_bool("requires_restart", false)       // Boolean metadata
//!     .meta_num("order", 10.0)                    // Numeric metadata
//!     .meta_num("priority", 5.0)                  // Numeric metadata
//!     .meta("custom_obj", json!({"key": "value"})); // Any JSON value
//!
//! // Retrieve metadata
//! assert_eq!(setting.get_meta_str("label"), Some("My Label"));
//! assert_eq!(setting.get_meta_bool("advanced"), Some(true));
//! assert_eq!(setting.get_meta_num("order"), Some(10.0));
//! ```
//!
//! # Internal Metadata Keys
//!
//! The library only defines two metadata keys that it uses internally:
//!
//! - `meta::SECRET` - Mark as secret (triggers credential storage)
//! - `meta::ENV_OVERRIDE` - Populated at runtime when env var overrides value
//!
//! Everything else (label, category, description, advanced, order, etc.) is custom metadata
//! that you define based on your application's needs.
//!
//! # Type Safety for Required Metadata
//!
//! ## Select Type Enforces Options
//!
//! ```rust,no_run
//! use rcman::{SettingMetadata, opt};
//!
//! // ✅ Correct - options required at construction
//! let setting = SettingMetadata::select("default", vec![
//!     opt("opt1", "Option 1"),
//!     opt("opt2", "Option 2"),
//! ]);
//!
//! // Options are in constraints.options
//! assert!(setting.constraints.options.is_some());
//! ```
//!
//! ## Schema Validation
//!
//! Call `validate_schema()` to ensure metadata is properly configured:
//!
//! ```rust,no_run
//! use rcman::SettingMetadata;
//!
//! let setting = SettingMetadata::number(50.0)
//!     .min(0.0)
//!     .max(100.0);
//!
//! // ✅ Valid: min <= max
//! assert!(setting.validate_schema().is_ok());
//!
//! // ❌ Invalid: min > max
//! let invalid = SettingMetadata::number(50.0)
//!     .min(100.0)
//!     .max(0.0);
//! assert!(invalid.validate_schema().is_err());
//! ```
//!
//! # Integration with Derive Macro
//!
//! The derive macro generates metadata using the dynamic API:
//!
//! ```rust,no_run
//! #[cfg(feature = "derive")]
//! fn derive_schema_example() {
//!     use rcman::{DeriveSettingsSchema, SettingsSchema};
//!     use serde::{Serialize, Deserialize};
//!
//!     #[derive(DeriveSettingsSchema, Serialize, Deserialize, Default)]
//!     #[schema(category = "appearance")]
//!     struct UiSettings {
//!         // Constraints handled by derive
//!         #[setting(min = 8, max = 32)]
//!         font_size: u32,
//!
//!         // Simple toggle
//!         dark_mode: bool,
//!     }
//!
//!     // Add UI metadata manually after generation if needed:
//!     let mut metadata = UiSettings::get_metadata();
//!     if let Some(setting) = metadata.get_mut("appearance.dark_mode") {
//!         *setting = setting.clone()
//!             .meta_str("label", "Dark Mode")
//!             .meta_str("description", "Enable dark theme");
//!     }
//! }
//!
//! #[cfg(not(feature = "derive"))]
//! fn derive_schema_example() {
//!     // Derive-based schema examples are only available when the `derive` feature is enabled.
//! }
//!
//! derive_schema_example();
//! ```

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

// =============================================================================
// Well-known Metadata Keys
// =============================================================================

/// Internal metadata keys used by the library itself.
///
/// These constants are for metadata that the library actually uses internally.
/// For custom metadata (like "advanced", "order", "`requires_restart`", etc.),
/// just use string literals directly with `.meta_str()`, `.meta_bool()`, etc.
///
/// # Example
///
/// ```
/// use rcman::{SettingMetadata, meta};
///
/// let setting = SettingMetadata::text("default")
///     .meta_str("label", "My Label")           // Custom metadata
///     .meta_str("category", "general")         // Custom metadata
///     .meta_bool("advanced", true)             // Custom metadata
///     .meta_num("order", 1);                   // Custom metadata
/// ```
pub mod meta {
    /// Mark as secret (stored in credential manager) - used by credential system
    pub const SECRET: &str = "secret";
    /// Environment variable override indicator - populated at runtime by manager
    pub const ENV_OVERRIDE: &str = "env_override";
}

// =============================================================================
// Setting Types
// =============================================================================

/// Type of setting for UI rendering
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SettingType {
    /// Boolean toggle
    Toggle,
    /// Text input
    #[default]
    Text,
    /// Numeric input
    Number,
    /// Dropdown/select with predefined options
    Select,
    /// Read-only display
    Info,
    /// List of strings
    List,
    /// Arbitrary JSON Object / Value
    Object,
}

// =============================================================================
// Type-Specific Constraints
// =============================================================================

/// Constraints for Number type settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct NumberConstraints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
}

/// Constraints for Text type settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TextConstraints {
    /// Regex pattern for validation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

/// Match mode for list reservations
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReservedMatchMode {
    /// Exact string match only
    #[default]
    Exact,
    /// Exact match OR prefix match with equals (e.g. "foo" matches "foo=bar")
    PrefixEquals,
    /// Exact match OR split by space (e.g. "foo" matches "foo bar")
    PrefixSpace,
    /// Combined CLI style checking both space and equals
    CliFlag,
}

/// Constraints for List type settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ListConstraints {
    /// Reserved values that cannot be used
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved: Option<Vec<String>>,
    /// How to match reserved values
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_mode: Option<ReservedMatchMode>,
}

/// Type-specific constraints
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SettingConstraints {
    /// Options for Select type (REQUIRED for Select)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SettingOption>>,

    /// Number constraints
    #[serde(flatten)]
    pub number: NumberConstraints,

    /// Text constraints
    #[serde(flatten)]
    pub text: TextConstraints,

    /// List constraints
    #[serde(flatten)]
    pub list: ListConstraints,
}

// =============================================================================
// Setting Metadata
// =============================================================================

/// Metadata for a single setting
///
/// # Example
///
/// ```
/// use rcman::{SettingMetadata, opt};
///
/// // Toggle setting with dynamic metadata
/// let dark_mode = SettingMetadata::toggle(false)
///     .meta_str("label", "Dark Mode")
///     .meta_str("description", "Enable dark theme")
///     .meta_str("category", "appearance");
///
/// // Number with range
/// let font_size = SettingMetadata::number(14.0)
///     .min(8.0).max(32.0).step(1.0)
///     .meta_str("label", "Font Size");
///
/// // Select with options (options required at construction)
/// let theme = SettingMetadata::select("dark", vec![
///     opt("light", "Light"),
///     opt("dark", "Dark"),
/// ])
/// .meta_str("label", "Theme");
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingMetadata {
    /// Type of setting (for UI rendering)
    #[serde(rename = "type")]
    pub setting_type: SettingType,

    /// Default value
    pub default: Value,

    /// Current value (populated at runtime)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,

    /// Type-specific constraints
    #[serde(flatten)]
    pub constraints: SettingConstraints,

    /// Developer-defined custom metadata (fully dynamic)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, Value>,
}

impl Default for SettingMetadata {
    fn default() -> Self {
        Self {
            setting_type: SettingType::Text,
            default: Value::Null,
            value: None,
            constraints: SettingConstraints::default(),
            metadata: HashMap::new(),
        }
    }
}

impl SettingMetadata {
    // =========================================================================
    // Type-specific constructors
    // =========================================================================

    /// Create a text input setting
    pub fn text(default: impl Into<String>) -> Self {
        Self {
            setting_type: SettingType::Text,
            default: Value::String(default.into()),
            ..Default::default()
        }
    }

    /// Create a number input setting
    pub fn number(default: impl Into<f64>) -> Self {
        Self {
            setting_type: SettingType::Number,
            default: json!(default.into()),
            ..Default::default()
        }
    }

    /// Create a toggle/boolean setting
    #[must_use]
    pub fn toggle(default: bool) -> Self {
        Self {
            setting_type: SettingType::Toggle,
            default: Value::Bool(default),
            ..Default::default()
        }
    }

    /// Create a select/dropdown setting
    ///
    /// **Options are required** - you must provide them at construction time.
    pub fn select(default: impl Into<String>, options: Vec<SettingOption>) -> Self {
        Self {
            setting_type: SettingType::Select,
            default: Value::String(default.into()),
            constraints: SettingConstraints {
                options: Some(options),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// Create an info/read-only setting
    #[must_use]
    pub fn info(default: Value) -> Self {
        Self {
            setting_type: SettingType::Info,
            default,
            ..Default::default()
        }
    }

    /// Create a list setting (`Vec<String>`)
    #[must_use]
    pub fn list(default: &[String]) -> Self {
        Self {
            setting_type: SettingType::List,
            default: json!(default),
            ..Default::default()
        }
    }

    /// Create an arbitrary JSON object setting (`serde_json::Value`)
    #[must_use]
    pub fn object(default: Value) -> Self {
        Self {
            setting_type: SettingType::Object,
            default,
            ..Default::default()
        }
    }

    // =========================================================================
    // Dynamic metadata methods
    // =========================================================================

    /// Add custom string metadata
    #[must_use]
    pub fn meta_str(mut self, key: &str, value: impl Into<String>) -> Self {
        self.metadata
            .insert(key.to_string(), Value::String(value.into()));
        self
    }

    /// Add custom boolean metadata
    #[must_use]
    pub fn meta_bool(mut self, key: &str, value: bool) -> Self {
        self.metadata.insert(key.to_string(), Value::Bool(value));
        self
    }

    /// Add custom number metadata
    #[must_use]
    pub fn meta_num(mut self, key: &str, value: impl Into<f64>) -> Self {
        self.metadata.insert(key.to_string(), json!(value.into()));
        self
    }

    /// Add custom JSON metadata
    #[must_use]
    pub fn meta(mut self, key: &str, value: Value) -> Self {
        self.metadata.insert(key.to_string(), value);
        self
    }

    /// Get custom metadata by key
    #[must_use]
    pub fn get_meta(&self, key: &str) -> Option<&Value> {
        self.metadata.get(key)
    }

    /// Get custom string metadata
    #[must_use]
    pub fn get_meta_str(&self, key: &str) -> Option<&str> {
        self.metadata.get(key).and_then(|v| v.as_str())
    }

    /// Get custom boolean metadata
    #[must_use]
    pub fn get_meta_bool(&self, key: &str) -> Option<bool> {
        self.metadata.get(key).and_then(Value::as_bool)
    }

    /// Get custom numeric metadata
    #[must_use]
    pub fn get_meta_num(&self, key: &str) -> Option<f64> {
        self.metadata.get(key).and_then(Value::as_f64)
    }

    // =========================================================================
    // Number constraint setters (builder pattern)
    // =========================================================================

    /// Set minimum value for Number type
    #[must_use]
    pub fn min(mut self, val: f64) -> Self {
        self.constraints.number.min = Some(val);
        self
    }

    /// Set maximum value for Number type
    #[must_use]
    pub fn max(mut self, val: f64) -> Self {
        self.constraints.number.max = Some(val);
        self
    }

    /// Set step for Number type
    #[must_use]
    pub fn step(mut self, val: f64) -> Self {
        self.constraints.number.step = Some(val);
        self
    }

    // =========================================================================
    // Text constraint setters (builder pattern)
    // =========================================================================

    /// Set regex pattern for validation
    #[must_use]
    pub fn pattern(mut self, pattern: impl Into<String>) -> Self {
        self.constraints.text.pattern = Some(pattern.into());
        self
    }

    // =========================================================================
    // List constraint setters (builder pattern)
    // =========================================================================

    /// Set reserved values for List type
    #[must_use]
    pub fn reserved(mut self, reserved: Vec<String>) -> Self {
        self.constraints.list.reserved = Some(reserved);
        self
    }

    /// Set reserved match mode for List type
    #[must_use]
    pub fn match_mode(mut self, mode: ReservedMatchMode) -> Self {
        self.constraints.list.match_mode = Some(mode);
        self
    }

    // Secret storage (special handling)

    /// Mark setting as secret (stored in credential manager)
    ///
    /// Note: Setting this flag requires credential features to be enabled
    /// (`keychain` or `encrypted-file`) for actual secret storage to work.
    /// Without these features, the flag is set but secrets won't be stored securely.
    #[must_use]
    pub fn secret(mut self) -> Self {
        self.metadata
            .insert(meta::SECRET.to_string(), Value::Bool(true));
        self
    }

    /// Check if this setting is marked as secret
    #[must_use]
    pub fn is_secret(&self) -> bool {
        self.get_meta_bool(meta::SECRET).unwrap_or(false)
    }

    // =========================================================================
    // Validation
    // =========================================================================

    /// Validate a value against this setting's constraints
    ///
    /// Checks:
    /// - Number range (min/max)
    /// - Regex pattern for text
    /// - Valid option for select type
    /// - Type compatibility
    ///
    /// # Errors
    /// Returns an error message if validation fails (type mismatch, out of range, invalid pattern, etc.)
    pub fn validate(&self, value: &Value) -> Result<(), String> {
        match self.setting_type {
            SettingType::Toggle => Self::validate_toggle(value),
            SettingType::Number => self.validate_number(value),
            SettingType::Text => self.validate_text(value),
            SettingType::Select => self.validate_select(value),
            SettingType::List => self.validate_list(value),
            SettingType::Info | SettingType::Object => Ok(()), // Read-only / untyped JSON, no validation needed
        }
    }

    fn validate_toggle(value: &Value) -> Result<(), String> {
        if !value.is_boolean() {
            return Err("Value must be a boolean".to_string());
        }
        Ok(())
    }

    fn validate_number(&self, value: &Value) -> Result<(), String> {
        let num = value
            .as_f64()
            .ok_or_else(|| "Value must be a number".to_string())?;

        if let Some(min) = self.constraints.number.min
            && num < min
        {
            return Err(format!("Value must be at least {min}"));
        }
        if let Some(max) = self.constraints.number.max
            && num > max
        {
            return Err(format!("Value must be at most {max}"));
        }
        Ok(())
    }

    fn validate_text(&self, value: &Value) -> Result<(), String> {
        let text = value
            .as_str()
            .ok_or_else(|| "Value must be a string".to_string())?;

        if let Some(ref pattern) = self.constraints.text.pattern {
            let re =
                regex::Regex::new(pattern).map_err(|e| format!("Invalid regex pattern: {e}"))?;
            if !re.is_match(text) {
                return Err(format!("Value does not match pattern: {pattern}"));
            }
        }
        Ok(())
    }

    fn validate_select(&self, value: &Value) -> Result<(), String> {
        if let Some(ref options) = self.constraints.options {
            let is_valid = options.iter().any(|opt| opt.value == *value);
            if !is_valid {
                return Err("Value must be one of the available options".to_string());
            }
        }
        Ok(())
    }

    fn validate_list(&self, value: &Value) -> Result<(), String> {
        if !value.is_array() {
            return Err("Value must be an array".to_string());
        }

        // Check reserved values
        if let Some(reserved) = &self.constraints.list.reserved {
            let mode = self
                .constraints
                .list
                .match_mode
                .as_ref()
                .unwrap_or(&ReservedMatchMode::Exact);

            if let Some(arr) = value.as_array() {
                for item in arr {
                    if let Some(s) = item.as_str() {
                        Self::check_reserved_item(s, reserved, mode)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn check_reserved_item(
        item: &str,
        reserved: &[String],
        mode: &ReservedMatchMode,
    ) -> Result<(), String> {
        for r in reserved {
            match mode {
                ReservedMatchMode::Exact => {
                    if item == r {
                        return Err(format!("Value '{item}' is a reserved value"));
                    }
                }
                ReservedMatchMode::PrefixEquals => {
                    if item == r || item.starts_with(&format!("{r}=")) {
                        return Err(format!("Value '{item}' matches reserved prefix '{r}'"));
                    }
                }
                ReservedMatchMode::PrefixSpace => {
                    if item == r {
                        return Err(format!("Value '{item}' is a reserved value"));
                    }
                    if let Some((key, _)) = item.split_once(' ')
                        && key == r
                    {
                        return Err(format!("Value '{item}' matches reserved prefix '{r}'"));
                    }
                }
                ReservedMatchMode::CliFlag => {
                    if item == r || item.starts_with(&format!("{r}=")) {
                        return Err(format!("Value '{item}' matches reserved flag '{r}'"));
                    }
                    if let Some((key, _)) = item.split_once(' ')
                        && key == r
                    {
                        return Err(format!("Value '{item}' matches reserved flag '{r}'"));
                    }
                }
            }
        }
        Ok(())
    }

    /// Validate the schema definition itself
    ///
    /// Checks that the metadata is properly configured:
    /// - Select type has options
    /// - Number range has min <= max
    /// - Step is positive
    /// - Pattern is valid regex
    /// - Default value satisfies constraints
    ///
    /// # Errors
    /// Returns an error if schema is inconsistent (min > max, invalid regex, empty pattern, etc.)
    pub fn validate_schema(&self) -> Result<(), String> {
        // Check select has options
        if self.setting_type == SettingType::Select && self.constraints.options.is_none() {
            return Err("Select type must have options defined".to_string());
        }

        // Check number range validity
        if let (Some(min), Some(max)) = (self.constraints.number.min, self.constraints.number.max)
            && min > max
        {
            return Err(format!("min ({min}) cannot be greater than max ({max})"));
        }

        // Check step is positive
        if let Some(step) = self.constraints.number.step
            && step <= 0.0
        {
            return Err(format!("step must be positive, got {step}"));
        }

        // Check pattern is valid regex
        if let Some(ref pattern) = self.constraints.text.pattern {
            regex::Regex::new(pattern).map_err(|e| format!("Invalid regex pattern: {e}"))?;

            // Pattern should not be empty
            if pattern.is_empty() {
                return Err("Pattern cannot be empty string".to_string());
            }
        }

        // Validate default value against constraints
        self.validate(&self.default)
            .map_err(|e| format!("Default value is invalid: {e}"))?;

        Ok(())
    }
}

// =============================================================================
// Setting Option
// =============================================================================

/// Option for Select type settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SettingOption {
    /// Value to store
    pub value: Value,
    /// Display label
    pub label: String,
    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl SettingOption {
    /// Create a simple string option
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        let value_str = value.into();
        Self {
            value: Value::String(value_str),
            label: label.into(),
            description: None,
        }
    }

    /// Create an option with description
    pub fn with_description(
        value: impl Into<String>,
        label: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        let value_str = value.into();
        Self {
            value: Value::String(value_str),
            label: label.into(),
            description: Some(description.into()),
        }
    }
}

// =============================================================================
// Settings Schema Trait
// =============================================================================

/// Trait for types that define a settings schema
///
/// Implement this trait for your application's settings struct to provide
/// metadata about available settings.
pub trait SettingsSchema: Default + Serialize + for<'de> Deserialize<'de> {
    /// Get metadata for all settings
    ///
    /// The key format should be "`category.setting_name`" (e.g., "general.language")
    fn get_metadata() -> HashMap<String, SettingMetadata>;

    /// Get list of categories in display order
    #[must_use]
    fn get_categories() -> Vec<String> {
        let metadata = Self::get_metadata();
        let mut categories: Vec<String> = metadata
            .values()
            .filter_map(|m| m.get_meta_str("category").map(String::from))
            .collect();
        categories.sort();
        categories.dedup();
        categories
    }
}

// Default implementation for () to allow DynamicManager (no schema)
impl SettingsSchema for () {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        HashMap::new()
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Shorthand for creating a `SettingOption`
///
/// # Example
/// ```rust
/// use rcman::opt;
/// let options = vec![opt("light", "Light Mode"), opt("dark", "Dark Mode")];
/// ```
pub fn opt(value: impl Into<String>, label: impl Into<String>) -> SettingOption {
    SettingOption::new(value, label)
}

/// Macro for building settings metadata `HashMap` more cleanly
///
/// # Example
/// ```rust,compile_fail
/// use rcman::{settings, SettingsSchema, SettingMetadata, opt};
/// use std::collections::HashMap;
///
/// impl SettingsSchema for MySettings {
///     fn get_metadata() -> HashMap<String, SettingMetadata> {
///         settings! {
///             "ui.theme" => SettingMetadata::select("dark", vec![
///                 opt("light", "Light"),
///                 opt("dark", "Dark"),
///             ])
///             .meta_str("label", "Theme"),
///
///             "ui.font_size" => SettingMetadata::number(14.0)
///                 .min(8.0).max(32.0)
///                 .meta_str("label", "Font Size"),
///
///             "api.key" => SettingMetadata::text("")
///                 .meta_str("label", "API Key")
///                 .meta_str("input_type", "password")
///                 .secret(),
///         }
///     }
/// }
/// ```
#[macro_export]
macro_rules! settings {
    ($($key:expr => $value:expr),* $(,)?) => {{
        let mut map = std::collections::HashMap::new();
        $(
            map.insert($key.to_string(), $value);
        )*
        map
    }};
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_setting_metadata_builder() {
        let setting = SettingMetadata::toggle(true)
            .meta_str("label", "Dark Mode")
            .meta_str("description", "Enable dark theme")
            .meta_str("category", "appearance")
            .meta_num("order", 1.0);

        assert_eq!(setting.setting_type, SettingType::Toggle);
        assert_eq!(setting.default, Value::Bool(true));
        assert_eq!(setting.get_meta_str("label"), Some("Dark Mode"));
        assert_eq!(
            setting.get_meta_str("description"),
            Some("Enable dark theme")
        );
        assert_eq!(setting.get_meta_str("category"), Some("appearance"));
        assert_eq!(setting.get_meta_num("order"), Some(1.0));
    }

    #[test]
    fn test_select_setting() {
        let options = vec![
            SettingOption::new("en", "English"),
            SettingOption::new("tr", "Turkish"),
            SettingOption::new("de", "German"),
        ];

        let setting = SettingMetadata::select("en", options);

        assert_eq!(setting.setting_type, SettingType::Select);
        assert_eq!(setting.constraints.options.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn test_number_setting_with_range() {
        let setting = SettingMetadata::number(50.0).min(0.0).max(100.0).step(5.0);

        assert_eq!(setting.constraints.number.min, Some(0.0));
        assert_eq!(setting.constraints.number.max, Some(100.0));
        assert_eq!(setting.constraints.number.step, Some(5.0));
    }

    #[test]
    fn test_number_validation() {
        let setting = SettingMetadata::number(8080.0).min(1.0).max(65535.0);

        // Valid values
        assert!(setting.validate(&Value::from(8080)).is_ok());
        assert!(setting.validate(&Value::from(1)).is_ok());
        assert!(setting.validate(&Value::from(65535)).is_ok());

        // Invalid values
        assert!(setting.validate(&Value::from(0)).is_err());
        assert!(setting.validate(&Value::from(70000)).is_err());
        assert!(setting.validate(&Value::from("not a number")).is_err());
    }

    #[test]
    fn test_text_pattern_validation() {
        let setting = SettingMetadata::text("").pattern(r"^[\w.-]+@[\w.-]+\.\w+$");

        // Valid emails
        assert!(setting.validate(&Value::from("user@example.com")).is_ok());
        assert!(
            setting
                .validate(&Value::from("test.user@domain.org"))
                .is_ok()
        );

        // Invalid emails
        let result = setting.validate(&Value::from("not-an-email"));
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            r"Value does not match pattern: ^[\w.-]+@[\w.-]+\.\w+$"
        );
    }

    #[test]
    fn test_select_validation() {
        let options = vec![
            SettingOption::new("en", "English"),
            SettingOption::new("tr", "Turkish"),
        ];
        let setting = SettingMetadata::select("en", options);

        // Valid options
        assert!(setting.validate(&Value::from("en")).is_ok());
        assert!(setting.validate(&Value::from("tr")).is_ok());

        // Invalid option
        assert!(setting.validate(&Value::from("invalid")).is_err());
    }

    #[test]
    fn test_toggle_validation() {
        let setting = SettingMetadata::toggle(false);

        assert!(setting.validate(&Value::Bool(true)).is_ok());
        assert!(setting.validate(&Value::Bool(false)).is_ok());
        assert!(setting.validate(&Value::from("true")).is_err());
    }

    #[test]
    fn test_list_validation() {
        let setting = SettingMetadata::list(&["default".to_string()]);

        assert!(setting.validate(&json!(["one", "two"])).is_ok());
        assert!(setting.validate(&json!([])).is_ok());
        assert!(setting.validate(&Value::from("not an array")).is_err());
    }

    #[test]
    fn test_path_setting() {
        let setting = SettingMetadata::text("/home/user/.config")
            .meta_str("label", "Config Directory")
            .meta_str("description", "Directory for configuration files")
            .meta_str("input_type", "path");

        assert_eq!(setting.setting_type, SettingType::Text);
        assert_eq!(setting.default, Value::String("/home/user/.config".into()));
        assert_eq!(setting.get_meta_str("label"), Some("Config Directory"));
        assert_eq!(setting.get_meta_str("input_type"), Some("path"));
    }

    #[test]
    fn test_file_setting() {
        let setting = SettingMetadata::text("/etc/app/config.json")
            .meta_str("label", "Config File")
            .meta_str("input_type", "file");

        assert_eq!(setting.setting_type, SettingType::Text);
        assert_eq!(
            setting.default,
            Value::String("/etc/app/config.json".into())
        );
        assert_eq!(setting.get_meta_str("input_type"), Some("file"));
    }

    #[test]
    fn test_list_setting() {
        let default_items = vec!["item1".to_string(), "item2".to_string()];
        let setting = SettingMetadata::list(&default_items)
            .meta_str("label", "Tags")
            .meta_str("description", "List of tags")
            .meta_str("category", "metadata");

        assert_eq!(setting.setting_type, SettingType::List);
        assert_eq!(setting.default, json!(default_items));
        assert_eq!(setting.get_meta_str("label"), Some("Tags"));
    }

    #[test]
    fn test_custom_metadata() {
        let setting = SettingMetadata::text("default")
            .meta_str("label", "My Setting")
            .meta_bool("requires_restart", true)
            .meta_bool("advanced", true)
            .meta_str("deprecated_since", "2.0")
            .meta_num("priority", 10.0)
            .meta("custom_obj", json!({"key": "value"}));

        assert_eq!(setting.get_meta_str("label"), Some("My Setting"));
        assert_eq!(setting.get_meta_bool("requires_restart"), Some(true));
        assert_eq!(setting.get_meta_bool("advanced"), Some(true));
        assert_eq!(setting.get_meta_str("deprecated_since"), Some("2.0"));
        assert_eq!(setting.get_meta_num("priority"), Some(10.0));
        assert_eq!(
            setting.get_meta("custom_obj"),
            Some(&json!({"key": "value"}))
        );
    }

    #[test]
    fn test_schema_validation() {
        // Valid schema
        let valid = SettingMetadata::number(50.0).min(0.0).max(100.0);
        assert!(valid.validate_schema().is_ok());

        // Invalid: min > max
        let invalid_range = SettingMetadata::number(50.0).min(100.0).max(0.0);
        assert!(invalid_range.validate_schema().is_err());

        // Invalid: select without options
        let mut invalid_select = SettingMetadata::text("test");
        invalid_select.setting_type = SettingType::Select;
        assert!(invalid_select.validate_schema().is_err());
    }

    #[test]
    fn test_serialization() {
        let setting = SettingMetadata::number(14.0)
            .min(8.0)
            .max(32.0)
            .meta_str("label", "Font Size")
            .meta_str("category", "ui");

        let json = serde_json::to_string(&setting).unwrap();
        let deserialized: SettingMetadata = serde_json::from_str(&json).unwrap();

        assert_eq!(setting.setting_type, deserialized.setting_type);
        assert_eq!(setting.default, deserialized.default);
        assert_eq!(
            setting.constraints.number.min,
            deserialized.constraints.number.min
        );
        assert_eq!(
            setting.get_meta_str("label"),
            deserialized.get_meta_str("label")
        );
    }

    #[test]
    fn test_reserved_list_validation() {
        let meta = SettingMetadata::list(&[])
            .reserved(vec!["--rc-serve".to_string(), "--log-file".to_string()])
            .match_mode(ReservedMatchMode::CliFlag);

        // Valid values
        assert!(meta.validate(&json!(["--other-flag"])).is_ok());
        assert!(meta.validate(&json!(["--rc-something-else"])).is_ok());

        // Exact match reserved
        assert!(meta.validate(&json!(["--rc-serve"])).is_err());
        assert!(meta.validate(&json!(["--log-file"])).is_err());

        // Prefix match reserved (flag with value)
        assert!(meta.validate(&json!(["--rc-serve=true"])).is_err());
        assert!(meta.validate(&json!(["--log-file=/tmp/log"])).is_err());
        assert!(meta.validate(&json!(["--rc-serve :5572"])).is_err()); // Space separated check
        assert!(meta.validate(&json!(["--log-file /tmp/log"])).is_err()); // Space separated check

        // Check error message
        let err = meta.validate(&json!(["--rc-serve=true"])).unwrap_err();
        assert!(err.contains("Value '--rc-serve=true' matches reserved flag '--rc-serve'"));
    }
}
