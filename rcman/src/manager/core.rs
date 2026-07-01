#[cfg(feature = "backup")]
use crate::backup::ExternalConfigProvider;
#[cfg(any(feature = "keychain", feature = "encrypted-file"))]
use crate::config::CredentialConfig;
use crate::config::{SettingMetadata, SettingsConfig, SettingsSchema};
#[cfg(any(feature = "keychain", feature = "encrypted-file"))]
use crate::credentials::CredentialManager;
use crate::error::Result;
use crate::manager::EventManager;
use crate::manager::cache::SettingsCache;
use crate::manager::env::EnvironmentHandler;
use crate::storage::StorageBackend;
use crate::sub_settings::SubSettings;

use serde_json::Value;
use std::collections::HashMap;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex, RwLock};

/// Main settings manager for loading, saving, and managing application settings.
///
/// The `SettingsManager` provides a complete solution for application configuration:
///
/// - **Load/Save Settings**: Read and write settings with schema validation
/// - **Sub-Settings**: Manage per-entity configuration files (e.g., per-remote configs)
/// - **Change Events**: Register callbacks for setting changes
/// - **Backup/Restore**: Create and restore encrypted backups
/// - **Caching**: In-memory caching for fast access
/// - **Secret Settings**: Automatic keychain storage for sensitive values
///
/// # Example
///
/// ```rust,no_run
/// use rcman::{SettingsManager, SettingsConfig};
///
/// // Create with builder
/// let config = SettingsConfig::builder("my-app", "1.0.0")
///     .with_config_dir("~/.config/my-app")
///     .with_credentials()  // Enable secret storage
///     .build();
///
/// let manager = SettingsManager::new(config).unwrap();
/// ```
///
/// # Type Parameters
///
/// * `Schema`: The settings schema type (defaults to `()` for dynamic usage).
pub struct SettingsManager<
    S: StorageBackend = crate::storage::JsonStorage,
    Schema: SettingsSchema = (),
> {
    /// Configuration
    pub(super) config: SettingsConfig<S, Schema>,

    /// Storage backend (defaults to `JsonStorage`)
    pub(super) storage: S,

    /// Directory where settings file is located (may change if profiles enabled)
    pub(super) settings_dir: RwLock<std::path::PathBuf>,

    /// Registered sub-settings handlers
    pub(super) sub_settings: RwLock<HashMap<String, Arc<SubSettings<S>>>>,

    /// Event manager for change callbacks and validation
    pub(super) events: Arc<EventManager>,

    /// Unified settings cache
    pub(super) settings_cache: SettingsCache,

    /// Serializes non-secret settings write transactions to avoid read-modify-write races.
    pub(super) settings_write_lock: Mutex<()>,

    /// Environment variable handler
    pub(super) env_handler: EnvironmentHandler,

    /// Pre-computed schema defaults (shared across cache operations)
    pub(super) schema_defaults: Arc<HashMap<String, Value>>,

    /// Cached schema metadata (shared across read paths)
    pub(super) schema_metadata: Arc<HashMap<String, SettingMetadata>>,

    /// Credential manager for secret settings (optional, requires keychain or encrypted-file feature)
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(super) credentials: Option<CredentialManager>,

    /// Flag indicating if the credential store was upgraded (missing `__rcman_secrets__`)
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(super) is_upgraded: Arc<std::sync::atomic::AtomicBool>,

    /// External config providers for backups
    #[cfg(feature = "backup")]
    pub(crate) external_providers: RwLock<Vec<Box<dyn ExternalConfigProvider>>>,

    /// Profile manager for main settings (when profiles are enabled)
    #[cfg(feature = "profiles")]
    pub(super) profile_manager: Option<crate::profiles::ProfileManager<S>>,

    /// Marker for schema type
    pub(super) _schema: PhantomData<Schema>,
}

impl<S: StorageBackend + 'static, Schema: SettingsSchema> SettingsManager<S, Schema> {
    /// Create a new settings manager with the given configuration.
    ///
    /// This will create the config directory if it doesn't exist.
    ///
    /// # Arguments
    ///
    /// * `config` - Configuration specifying paths, app info, and storage backend
    ///
    /// # Errors
    ///
    /// Returns an error if the config directory cannot be created.
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// use rcman::{SettingsManager, SettingsConfig};
    ///
    /// let config = SettingsConfig::builder("my-app", "1.0.0").build();
    /// let manager = SettingsManager::new(config)?;
    /// # Ok::<(), rcman::Error>(())
    /// ```
    pub fn new(config: SettingsConfig<S, Schema>) -> Result<Self> {
        // Ensure config directory exists with secure permissions
        if !config.config_dir.exists() {
            crate::utils::security::ensure_secure_dir(&config.config_dir)?;
        }

        let storage = config.storage.clone();

        // Initialize credential manager if enabled and feature is available
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        let credentials = match &config.credential_config {
            CredentialConfig::Disabled => None,
            CredentialConfig::Default => {
                log::debug!("Credential management enabled with default backend");
                Some(CredentialManager::new(&config.app_name))
            }
            #[cfg(all(feature = "keychain", feature = "encrypted-file"))]
            CredentialConfig::WithFallback {
                fallback_path,
                password,
            } => {
                log::debug!(
                    "Credential management enabled with keychain and encrypted file fallback"
                );
                let path = fallback_path
                    .clone()
                    .unwrap_or_else(|| config.config_dir.join("secrets.enc"));
                Some(CredentialManager::with_fallback(
                    &config.app_name,
                    path,
                    password,
                ))
            }
            CredentialConfig::Custom(backend) => {
                log::debug!("Credential management enabled with custom backend");
                Some(CredentialManager::with_backend(
                    &config.app_name,
                    backend.clone(),
                ))
            }
        };

        // Initialize profile manager if profiles are enabled
        #[cfg(feature = "profiles")]
        let (settings_dir, profile_manager) = crate::profiles::ProfileManager::initialize(
            &config.config_dir,
            "settings",
            storage.clone(),
            config.profiles_enabled,
            &config.profile_migrator,
        )?;

        #[cfg(not(feature = "profiles"))]
        let settings_dir = config.config_dir.clone();

        // Pre-compute schema metadata/defaults ONCE (memory optimization)
        let metadata = Arc::new(Schema::get_metadata());
        let schema_defaults = Arc::new(
            metadata
                .iter()
                .map(|(k, m)| (k.clone(), m.default.clone()))
                .collect(),
        );

        let env_handler =
            EnvironmentHandler::new(config.env_prefix.clone(), config.env_source.clone());

        log::debug!(
            "Initialized rcman SettingsManager at: {:?}",
            config.config_dir.display()
        );

        let manager = Self {
            config,
            storage,
            settings_dir: RwLock::new(settings_dir),
            sub_settings: RwLock::new(HashMap::new()),
            events: Arc::new(EventManager::new()),
            settings_cache: SettingsCache::new(),
            settings_write_lock: Mutex::new(()),
            env_handler,
            schema_defaults,
            schema_metadata: metadata,
            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            credentials,

            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            is_upgraded: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            #[cfg(feature = "backup")]
            external_providers: RwLock::new(Vec::new()),
            #[cfg(feature = "profiles")]
            profile_manager,
            _schema: PhantomData,
        };

        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        manager.migrate_secret_keys()?;

        Ok(manager)
    }
    /// Get the configuration
    pub fn config(&self) -> &SettingsConfig<S, Schema> {
        &self.config
    }

    /// Get the storage backend
    pub fn storage(&self) -> &S {
        &self.storage
    }

    /// Get the event manager for registering change listeners and validators
    ///
    /// Callback semantics:
    /// - `save_setting()` emits callbacks only when the effective value changes.
    /// - `reset_setting()` delegates to `save_setting()`, so unchanged resets emit nothing.
    /// - `reset_all()` emits one callback per changed key (no callbacks for already-default values).
    /// - With profiles enabled, `switch_profile()` emits callbacks for keys whose effective
    ///   values differ between the old and new profiles.
    ///
    /// # Example
    ///
    /// ```
    /// # use rcman::*;
    /// # use std::sync::Arc;
    /// # use serde_json::Value;
    /// # let temp = tempfile::tempdir().unwrap();
    /// # let manager = SettingsManager::builder("test", "1.0")
    /// #     .with_config_dir(temp.path())
    /// #     .build()
    /// #     .unwrap();
    /// // Watch all changes
    /// manager.events().on_change(|key, old, new| {
    ///     println!("Changed {}: {:?} -> {:?}", key, old, new);
    /// });
    ///
    /// // Watch specific key
    /// manager.events().watch("ui.theme", |key, _old, new| {
    ///     println!("Theme changed to: {:?}", new);
    /// });
    ///
    /// // Add validator
    /// manager.events().add_validator("network.port", |v: &Value| {
    ///     if v.as_i64().map(|n| n > 0 && n <= 65535).unwrap_or(false) {
    ///         Ok(())
    ///     } else {
    ///         Err("Invalid port".into())
    ///     }
    /// });
    /// ```
    pub fn events(&self) -> &EventManager {
        &self.events
    }

    /// Get reference to credential manager (if configured)
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub fn credentials(&self) -> Option<&crate::credentials::CredentialManager> {
        self.credentials.as_ref()
    }

    /// Get reference to the schema metadata map
    #[cfg(all(
        feature = "backup",
        any(feature = "keychain", feature = "encrypted-file")
    ))]
    pub(crate) fn schema_metadata(&self) -> &HashMap<String, SettingMetadata> {
        &self.schema_metadata
    }
}

impl SettingsManager {
    /// Create a builder for `SettingsManager` with a fluent API.
    ///
    /// This is the recommended way to create a `SettingsManager`.
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
    ///     .build()
    ///     .unwrap();
    /// ```
    pub fn builder(
        app_name: impl Into<String>,
        app_version: impl Into<String>,
    ) -> crate::manager::SettingsManagerBuilder {
        crate::manager::SettingsManagerBuilder::<crate::storage::JsonStorage, ()>::new(
            app_name,
            app_version,
        )
    }
}
