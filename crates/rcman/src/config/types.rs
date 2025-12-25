//! Core types for rcman library

use std::path::PathBuf;

use crate::storage::{JsonStorage, StorageBackend};

#[cfg(feature = "backup")]
use crate::backup::ExternalConfig;

/// Configuration for initializing the SettingsManager
pub struct SettingsConfig<S: StorageBackend = JsonStorage> {
    /// Directory where settings files will be stored
    pub config_dir: PathBuf,

    /// Filename for the main settings file (e.g., "settings.json")
    pub settings_file: String,

    /// Application name (used in backup manifests)
    pub app_name: String,

    /// Application version (used for backup compatibility checks)
    pub app_version: String,

    /// Storage backend implementation
    pub storage: S,

    /// Enable credential management for secret settings
    pub enable_credentials: bool,

    /// Environment variable prefix for setting overrides (e.g., "MYAPP" -> MYAPP_UI_THEME)
    /// If None, env var overrides are disabled
    pub env_prefix: Option<String>,

    /// Allow environment variables to override secret settings (stored in keychain)
    /// Default: false (secrets are never overridden by env vars)
    pub env_overrides_secrets: bool,

    /// External configuration files registered for backup
    #[cfg(feature = "backup")]
    pub external_configs: Vec<ExternalConfig>,
}

impl Default for SettingsConfig<JsonStorage> {
    fn default() -> Self {
        Self {
            config_dir: PathBuf::from("."),
            settings_file: "settings.json".into(),
            app_name: "app".into(),
            app_version: "0.1.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            env_prefix: None,
            env_overrides_secrets: false,
            #[cfg(feature = "backup")]
            external_configs: Vec::new(),
        }
    }
}

impl<S: StorageBackend> SettingsConfig<S> {
    /// Get the full path to the main settings file
    pub fn settings_path(&self) -> PathBuf {
        self.config_dir.join(&self.settings_file)
    }
}

impl SettingsConfig<JsonStorage> {
    /// Create a new builder for SettingsConfig
    ///
    /// # Example
    /// ```rust
    /// use rcman::SettingsConfig;
    ///
    /// let config = SettingsConfig::builder("my-app", "1.0.0")
    ///     .config_dir("~/.config/my-app")
    ///     .build();
    /// ```
    pub fn builder(
        app_name: impl Into<String>,
        app_version: impl Into<String>,
    ) -> SettingsConfigBuilder {
        SettingsConfigBuilder::new(app_name, app_version)
    }
}

/// Builder for creating SettingsConfig with a fluent API
#[derive(Debug, Clone)]
pub struct SettingsConfigBuilder {
    config_dir: Option<PathBuf>,
    settings_file: String,
    app_name: String,
    app_version: String,
    pretty_json: bool,
    enable_credentials: bool,
    env_prefix: Option<String>,
    env_overrides_secrets: bool,
    #[cfg(feature = "backup")]
    external_configs: Vec<ExternalConfig>,
}

impl SettingsConfigBuilder {
    /// Create a new builder with required app name and version
    pub fn new(app_name: impl Into<String>, app_version: impl Into<String>) -> Self {
        Self {
            config_dir: None,
            settings_file: "settings.json".into(),
            app_name: app_name.into(),
            app_version: app_version.into(),
            pretty_json: true,
            enable_credentials: false,
            env_prefix: None,
            env_overrides_secrets: false,
            #[cfg(feature = "backup")]
            external_configs: Vec::new(),
        }
    }

    /// Set the configuration directory
    ///
    /// Supports `~` expansion for home directory.
    pub fn config_dir(mut self, path: impl Into<PathBuf>) -> Self {
        let path: PathBuf = path.into();
        // Expand ~ to home directory
        let expanded = if path.starts_with("~") {
            if let Some(home) = dirs::home_dir() {
                home.join(path.strip_prefix("~").unwrap_or(&path))
            } else {
                path
            }
        } else {
            path
        };
        self.config_dir = Some(expanded);
        self
    }

    /// Set the settings filename (default: "settings.json")
    pub fn settings_file(mut self, filename: impl Into<String>) -> Self {
        self.settings_file = filename.into();
        self
    }

    /// Use compact JSON (no pretty printing)
    pub fn compact_json(mut self) -> Self {
        self.pretty_json = false;
        self
    }

    /// Enable credential management for secret settings
    ///
    /// When enabled, settings marked as `secret: true` in metadata
    /// will be stored in the OS keychain instead of the settings file.
    pub fn with_credentials(mut self) -> Self {
        self.enable_credentials = true;
        self
    }

    /// Register an external configuration file for backup
    ///
    /// External configs are files managed outside of rcman (like rclone.conf)
    /// that can be included in backups.
    ///
    /// # Example
    /// ```rust,ignore
    /// let config = SettingsConfig::builder("my-app", "1.0.0")
    ///     .with_external_config(ExternalConfig::new("rclone", "/path/to/rclone.conf")
    ///         .display_name("Rclone Configuration"))
    ///     .build();
    /// ```
    #[cfg(feature = "backup")]
    pub fn with_external_config(mut self, config: ExternalConfig) -> Self {
        self.external_configs.push(config);
        self
    }

    /// Enable environment variable overrides
    ///
    /// When set, settings can be overridden by environment variables.
    /// The format is: `{PREFIX}_{CATEGORY}_{KEY}` (all uppercase, dots become underscores)
    ///
    /// # Example
    /// ```rust,ignore
    /// let config = SettingsConfig::builder("my-app", "1.0.0")
    ///     .with_env_prefix("MYAPP")
    ///     .build();
    ///
    /// // Now MYAPP_UI_THEME=dark will override the "ui.theme" setting
    /// ```
    pub fn with_env_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.env_prefix = Some(prefix.into());
        self
    }

    /// Allow environment variables to override secret settings
    ///
    /// By default, secrets stored in the OS keychain are NOT affected by env vars.
    /// Enable this for Docker/CI environments where secrets are passed via env.
    ///
    /// # Example
    /// ```rust,ignore
    /// let config = SettingsConfig::builder("my-app", "1.0.0")
    ///     .with_env_prefix("MYAPP")
    ///     .env_overrides_secrets(true)  // MYAPP_API_KEY will override keychain
    ///     .build();
    /// ```
    pub fn env_overrides_secrets(mut self, allow: bool) -> Self {
        self.env_overrides_secrets = allow;
        self
    }

    /// Build the SettingsConfig
    ///
    /// If `config_dir` is not set, uses the system config directory for the app.
    pub fn build(self) -> SettingsConfig<JsonStorage> {
        let config_dir = self.config_dir.unwrap_or_else(|| {
            // Use system config dir if available, otherwise current dir
            dirs::config_dir()
                .map(|d| d.join(&self.app_name))
                .unwrap_or_else(|| PathBuf::from("."))
        });

        let storage = if self.pretty_json {
            JsonStorage::new()
        } else {
            JsonStorage::compact()
        };

        SettingsConfig {
            config_dir,
            settings_file: self.settings_file,
            app_name: self.app_name,
            app_version: self.app_version,
            storage,
            enable_credentials: self.enable_credentials,
            env_prefix: self.env_prefix,
            env_overrides_secrets: self.env_overrides_secrets,
            #[cfg(feature = "backup")]
            external_configs: self.external_configs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builder_basic() {
        let config = SettingsConfig::builder("test-app", "1.0.0").build();

        assert_eq!(config.app_name, "test-app");
        assert_eq!(config.app_version, "1.0.0");
        assert_eq!(config.settings_file, "settings.json");
    }

    #[test]
    fn test_builder_with_options() {
        let config = SettingsConfig::builder("my-app", "2.0.0")
            .config_dir("/tmp/my-app")
            .settings_file("config.json")
            .compact_json()
            .build();

        assert_eq!(config.config_dir, PathBuf::from("/tmp/my-app"));
        assert_eq!(config.settings_file, "config.json");
    }
}
