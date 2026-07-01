//! Builder for `SettingsManager`
//!
//! This module contains [`SettingsManagerBuilder`] which provides a fluent API
//! for creating a [`SettingsManager`](super::SettingsManager).

use crate::config::SettingsConfigBuilder;
use crate::config::SettingsSchema;
use crate::error::Result;
use crate::storage::StorageBackend;
use crate::sub_settings::SubSettingsConfig;
use std::path::PathBuf;

use super::SettingsManager;

/// Builder for creating a [`SettingsManager`] with a fluent API.
///
/// This is the recommended way to create a `SettingsManager`. It allows you to
/// configure all options and register sub-settings in a single chain of calls.
///
/// # Example
///
/// ```rust,no_run
/// use rcman::{SettingsManager, SubSettingsConfig};
///
/// let manager = SettingsManager::builder("my-app", "1.0.0")
///     .with_config_dir("~/.config/my-app")
///     .with_credentials()
///     .with_sub_settings(SubSettingsConfig::new("remotes"))
///     .with_sub_settings(SubSettingsConfig::singlefile("backends"))
///     .build()
///     .unwrap();
/// ```
pub struct SettingsManagerBuilder<
    S: StorageBackend = crate::storage::JsonStorage,
    Schema: SettingsSchema = (),
> {
    config_builder: SettingsConfigBuilder<S, Schema>,
    sub_settings: Vec<SubSettingsConfig>,
}

impl<S: StorageBackend, Schema: SettingsSchema> SettingsManagerBuilder<S, Schema> {
    /// Create a new builder with required app name and version.
    pub fn new(
        app_name: impl Into<String>,
        app_version: impl Into<String>,
    ) -> SettingsManagerBuilder {
        SettingsManagerBuilder {
            config_builder: SettingsConfigBuilder::new(app_name, app_version),
            sub_settings: Vec::new(),
        }
    }
}

impl<S: StorageBackend, Schema: SettingsSchema> SettingsManagerBuilder<S, Schema> {
    /// Set the configuration directory path.
    ///
    /// If not set, uses the system config directory.
    #[must_use]
    pub fn with_config_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.config_builder = self.config_builder.with_config_dir(path);
        self
    }

    /// Set the settings filename (default: "settings.json").
    #[must_use]
    pub fn with_settings_file(mut self, filename: impl Into<String>) -> Self {
        self.config_builder = self.config_builder.settings_file(filename);
        self
    }

    /// Enable credential management for secret settings with default behavior.
    ///
    /// When enabled, settings marked as `secret: true` in metadata
    /// will be stored in the OS keychain instead of the settings file.
    #[must_use]
    pub fn with_credentials(mut self) -> Self {
        self.config_builder = self.config_builder.with_credentials();
        self
    }

    /// Extensively configure how credential secrets should be stored, enabling
    /// advanced scenarios like custom proxy backends or keychain fallbacks.
    ///
    /// # Example
    /// ```rust,ignore
    /// use rcman::{SettingsManager, CredentialConfig};
    ///
    /// let manager = SettingsManager::builder("my-app", "1.0.0")
    ///     .with_credential_config(CredentialConfig::WithFallback {
    ///         fallback_path: "/tmp/secrets.enc.json".into(),
    ///         encryption_key: [0u8; 32], // Use a derived key
    ///     })
    ///     .build()
    ///     .unwrap();
    /// ```
    #[must_use]
    pub fn with_credential_config(mut self, config: crate::config::CredentialConfig) -> Self {
        self.config_builder = self.config_builder.with_credential_config(config);
        self
    }

    /// Enable credentials with a default environment variable password source (Keychain + Encrypted File fallback).
    ///
    /// The environment variable name is automatically derived from the app name
    /// (e.g., "my-app" -> "`MY_APP_SECRET`").
    #[cfg(all(feature = "keychain", feature = "encrypted-file"))]
    #[must_use]
    pub fn with_env_credentials(mut self) -> Self {
        self.config_builder = self.config_builder.with_env_credentials();
        self
    }

    /// Enable credentials with a custom environment variable password source (Keychain + Encrypted File fallback).
    #[cfg(all(feature = "keychain", feature = "encrypted-file"))]
    #[must_use]
    pub fn with_custom_env_credentials(mut self, var_name: impl Into<String>) -> Self {
        self.config_builder = self.config_builder.with_custom_env_credentials(var_name);
        self
    }

    /// Enable credentials with file password source (Keychain + Encrypted File fallback).
    #[cfg(all(feature = "keychain", feature = "encrypted-file"))]
    #[must_use]
    pub fn with_file_credentials(mut self, path: impl Into<std::path::PathBuf>) -> Self {
        self.config_builder = self.config_builder.with_file_credentials(path);
        self
    }

    /// Enable credentials with provided password string (Keychain + Encrypted File fallback).
    #[cfg(all(feature = "keychain", feature = "encrypted-file"))]
    #[must_use]
    pub fn with_password_credentials(mut self, password: impl Into<String>) -> Self {
        self.config_builder = self.config_builder.with_password_credentials(password);
        self
    }

    /// Enable environment variable overrides.
    ///
    /// When set, settings can be overridden by environment variables.
    /// The format is: `{PREFIX}_{CATEGORY}_{KEY}` (all uppercase)
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// use rcman::SettingsManager;
    ///
    /// let manager = SettingsManager::builder("my-app", "1.0.0")
    ///     .with_env_prefix("MYAPP")
    ///     .build()
    ///     .unwrap();
    ///
    /// // Now MYAPP_UI_THEME=dark will override the "ui.theme" setting
    /// ```
    #[must_use]
    pub fn with_env_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.config_builder = self.config_builder.with_env_prefix(prefix);
        self
    }

    /// Allow environment variables to override secret settings.
    ///
    /// By default, secrets stored in the OS keychain are NOT affected by env vars.
    /// Enable this for Docker/CI environments where secrets are passed via env.
    #[must_use]
    pub fn env_overrides_secrets(mut self, allow: bool) -> Self {
        self.config_builder = self.config_builder.env_overrides_secrets(allow);
        self
    }

    /// Set a migration function for schema changes (lazy migration).
    ///
    /// The migrator function is called automatically when loading settings.
    /// If the function modifies the value, the migrated version is saved back.
    ///
    /// Use this to upgrade old data formats to new ones transparently.
    #[must_use]
    pub fn with_migrator<F>(mut self, migrator: F) -> Self
    where
        F: Fn(serde_json::Value) -> serde_json::Value + Send + Sync + 'static,
    {
        self.config_builder = self.config_builder.with_migrator(migrator);
        self
    }

    /// Enable hot-reload with default watcher configuration.
    #[cfg(feature = "hot-reload")]
    #[must_use]
    pub fn with_hot_reload(mut self) -> Self {
        self.config_builder = self.config_builder.with_hot_reload();
        self
    }

    /// Enable hot-reload with a custom watcher configuration.
    #[cfg(feature = "hot-reload")]
    #[must_use]
    pub fn with_hot_reload_config(mut self, config: crate::config::HotReloadConfig) -> Self {
        self.config_builder = self.config_builder.with_hot_reload_config(config);
        self
    }

    /// Register an external configuration file for backup.
    ///
    /// External configs are files managed outside of rcman (like rclone.conf)
    /// that can be included in backups.
    #[cfg(feature = "backup")]
    #[must_use]
    pub fn with_external_config(mut self, config: crate::backup::ExternalConfig) -> Self {
        self.config_builder = self.config_builder.with_external_config(config);
        self
    }

    /// Specify the schema type for the settings.
    ///
    /// This transforms the builder to use a typed schema instead of dynamic.
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// use rcman::{SettingsManager, SettingsSchema, SettingMetadata, settings};
    /// use serde::{Deserialize, Serialize};
    /// use std::collections::HashMap;
    ///
    /// #[derive(Debug, Clone, Serialize, Deserialize, Default)]
    /// struct AppSettings {
    ///     theme: String,
    /// }
    ///
    /// impl SettingsSchema for AppSettings {
    ///     fn get_metadata() -> HashMap<String, SettingMetadata> {
    ///         settings! {
    ///             "ui.theme" => SettingMetadata::text("dark").meta_str("label", "Theme")
    ///         }
    ///     }
    /// }
    ///
    /// let manager = SettingsManager::builder("my-app", "1.0.0")
    ///     .with_schema::<AppSettings>()
    ///     .build()
    ///     .unwrap();
    /// ```
    #[must_use]
    pub fn with_schema<NewSchema: SettingsSchema>(self) -> SettingsManagerBuilder<S, NewSchema> {
        SettingsManagerBuilder {
            config_builder: self.config_builder.with_schema::<NewSchema>(),
            sub_settings: self.sub_settings,
        }
    }

    /// Specify the storage backend type.
    ///
    /// This transforms the builder to use the specified storage backend.
    ///
    /// # Example
    /// ```rust,no_run
    /// use rcman::{SettingsManager, JsonStorage};
    ///
    /// let manager = SettingsManager::builder("my-app", "1.0.0")
    ///     .with_storage::<JsonStorage>()
    ///     .build()
    ///     .unwrap();
    /// ```
    #[must_use]
    pub fn with_storage<NewS: StorageBackend + Default>(
        self,
    ) -> SettingsManagerBuilder<NewS, Schema> {
        SettingsManagerBuilder {
            config_builder: self.config_builder.with_storage::<NewS>(),
            sub_settings: self.sub_settings,
        }
    }

    /// Enable profiles for main settings.
    ///
    /// When enabled, the main settings file is stored per-profile, allowing
    /// completely different app configurations (e.g., "work" vs "personal").
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// use rcman::SettingsManager;
    ///
    /// let manager = SettingsManager::builder("my-app", "1.0.0")
    ///     .with_profiles()  // Enable profiles
    ///     .build()?;
    ///
    /// // Switch the entire app to work profile
    /// manager.switch_profile("work")?;
    /// # Ok::<(), rcman::Error>(())
    /// ```
    #[cfg(feature = "profiles")]
    #[must_use]
    pub fn with_profiles(mut self) -> Self {
        self.config_builder = self.config_builder.with_profiles();
        self
    }

    /// Register a sub-settings type for per-entity configuration.
    ///
    /// Sub-settings allow you to manage separate config files for each entity
    /// (e.g., one file per remote, per profile, etc.).
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// use rcman::{SettingsManager, SubSettingsConfig};
    ///
    /// let manager = SettingsManager::builder("my-app", "1.0.0")
    ///     .with_sub_settings(SubSettingsConfig::new("remotes"))
    ///     .with_sub_settings(SubSettingsConfig::singlefile("backends"))
    ///     .build()
    ///     .unwrap();
    /// ```
    #[must_use]
    pub fn with_sub_settings(mut self, config: SubSettingsConfig) -> Self {
        self.sub_settings.push(config);
        self
    }

    /// Build the [`SettingsManager`].
    ///
    /// This creates the config directory if it doesn't exist, initializes
    /// the manager, and registers all sub-settings.
    ///
    /// # Errors
    ///
    /// Returns an error if the config directory cannot be created.
    pub fn build(self) -> Result<SettingsManager<S, Schema>>
    where
        S: Default + 'static,
    {
        let config = self.config_builder.build();
        let manager = SettingsManager::new(config)?;

        for sub_config in self.sub_settings {
            manager.register_sub_settings(sub_config)?;
        }

        Ok(manager)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builder_with_credentials_config() {
        let manager = SettingsManager::builder("my-app", "1.0.0")
            .with_config_dir("/tmp/my-app")
            .with_credential_config(crate::config::CredentialConfig::Default)
            .build()
            .unwrap();

        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        {
            assert!(manager.credentials.is_some());
        }

        #[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
        {
            let _ = manager;
        }
    }
}
