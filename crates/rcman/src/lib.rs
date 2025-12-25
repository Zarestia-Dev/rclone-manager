//! # rcman - Rust Config Manager
//!
//! A generic, framework-agnostic Rust library for managing application settings
//! with backup/restore, sub-settings, and automatic secret storage.
//!
//! ## Features
//!
//! - **Settings Management**: Load, save, and reset settings with schema metadata
//! - **Secret Settings**: Mark settings with `.secret()` to auto-store in OS keychain (requires `keychain` or `encrypted-file` feature)
//! - **Sub-Settings**: Per-entity configuration files (e.g., one file per "remote")
//! - **Backup & Restore**: Create and restore encrypted backups with AES-256
//! - **Schema Validation**: Regex patterns, numeric ranges, and option constraints
//! - **Performance**: In-memory caching for fast access
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use rcman::{SettingsManager, SettingsConfig};
//!
//! let config = SettingsConfig::builder("my-app", "1.0.0")
//!     .config_dir("~/.config/my-app")
//!     .with_credentials()  // Enable automatic secret storage
//!     .build();
//!
//! let manager = SettingsManager::new(config).unwrap();
//! ```
//!
//! ## Defining Settings Schema
//!
//! ```rust,no_run
//! use rcman::{settings, SettingsSchema, SettingMetadata, opt};
//! use serde::{Deserialize, Serialize};
//! use std::collections::HashMap;
//!
//! #[derive(Default, Serialize, Deserialize)]
//! struct MySettings {
//!     theme: String,
//!     font_size: f64,
//! }
//!
//! impl SettingsSchema for MySettings {
//!     fn get_metadata() -> HashMap<String, SettingMetadata> {
//!         settings! {
//!             "ui.theme" => SettingMetadata::select("Theme", "dark", vec![
//!                 opt("light", "Light"),
//!                 opt("dark", "Dark"),
//!             ]).category("appearance"),
//!
//!             "ui.font_size" => SettingMetadata::number("Font Size", 14.0)
//!                 .min(8.0).max(32.0).step(1.0),
//!
//!             "api.key" => SettingMetadata::password("API Key", "")
//!                 .secret(),  // Auto-stored in OS keychain!
//!         }
//!     }
//! }
//! ```
//!
//! ## Default Value Behavior
//!
//! When you save a setting that equals its default value, rcman **removes it from storage**
//! to keep files minimal. This applies to both regular settings and secrets:
//!
//! - **Regular settings**: Removed from JSON file
//! - **Secret settings**: Removed from keychain
//!
//! This means:
//! - Settings files only contain user customizations
//! - Changing defaults in code auto-applies to users who haven't customized
//! - Using `reset_setting()` removes the key from storage
//!
//! ## Sub-Settings (Per-Entity Config)
//!
//! ```rust,no_run
//! use rcman::{SettingsManager, SettingsConfig, SubSettingsConfig};
//! use serde_json::json;
//!
//! # fn example() -> rcman::Result<()> {
//! let config = SettingsConfig::builder("my-app", "1.0.0").build();
//! let manager = SettingsManager::new(config)?;
//!
//! // Multi-file mode (default): creates remotes/gdrive.json, remotes/s3.json
//! manager.register_sub_settings(SubSettingsConfig::new("remotes"));
//! let remotes = manager.sub_settings("remotes")?;
//! remotes.set("gdrive", &json!({"type": "drive"}))?;
//!
//! // Single-file mode: creates backends.json with all entities as keys
//! manager.register_sub_settings(SubSettingsConfig::new("backends").single_file());
//! let backends = manager.sub_settings("backends")?;
//! backends.set("gdrive", &json!({"type": "drive"}))?;
//! # Ok(())
//! # }
//! ```
//!
//! ## Backup & Restore
//!
//! ```rust,no_run
//! use rcman::{SettingsManager, SettingsConfig, BackupOptions, RestoreOptions};
//!
//! # fn example() -> rcman::Result<()> {
//! let config = SettingsConfig::builder("my-app", "1.0.0").build();
//! let manager = SettingsManager::new(config)?;
//!
//! // Create encrypted backup using builder pattern
//! let path = manager.backup()
//!     .create(BackupOptions::new()
//!         .output_dir("backups/")
//!         .password("secret")
//!         .note("Weekly backup"))?;
//!
//! // Analyze a backup before restoring (inspect contents, check if encrypted)
//! let analysis = manager.backup().analyze(&path)?;
//! println!("Encrypted: {}", analysis.requires_password);
//! println!("Valid: {}", analysis.is_valid);
//! println!("App version: {}", analysis.manifest.backup.app_version);
//!
//! // Restore from backup
//! manager.backup()
//!     .restore(RestoreOptions::from_path(&path)
//!         .password("secret")
//!         .overwrite(true))?;
//! # Ok(())
//! # }
//! ```
//!
//! ## Credentials
//!
//! **Note**: `CredentialManager` is only available when the `keychain` or `encrypted-file` feature is enabled.
//!
//! ```rust,no_run
//! #[cfg(feature = "keychain")]
//! {
//!     use rcman::CredentialManager;
//!
//!     let creds = CredentialManager::new("my-app");
//!     creds.store("api-key", "secret-value").unwrap();
//!     let key = creds.get("api-key").unwrap();
//! }
//! ```

// Core modules
mod docs;
mod error;
mod events;
mod manager;
mod storage;
mod sub_settings;

// Grouped modules
pub mod config;

#[cfg(feature = "backup")]
pub mod backup;

// Credentials always available (for SecretStorage type), backends are feature-gated
pub mod credentials;

// Re-exports from core
pub use docs::{generate_docs, generate_docs_from_metadata, DocsConfig};
pub use error::{Error, Result};
pub use events::EventManager;
pub use manager::SettingsManager;
pub use storage::{JsonStorage, StorageBackend};
pub use sub_settings::{SubSettings, SubSettingsConfig};

// Re-exports from config
pub use config::{
    opt, SettingMetadata, SettingOption, SettingType, SettingsConfig, SettingsConfigBuilder,
    SettingsSchema,
};

// Backup re-exports (feature-gated)
#[cfg(feature = "backup")]
pub use backup::{
    BackupAnalysis, BackupContents, BackupManager, BackupManifest, BackupOptions, ExportCategory,
    ExportCategoryType, ExportType, ExternalConfig, ExternalConfigProvider, RestoreOptions,
    RestoreResult,
};

// Credential re-exports (always available: SecretStorage; feature-gated: CredentialManager)
/// Credential Manager (requires `keychain` or `encrypted-file` feature)
#[cfg(any(feature = "keychain", feature = "encrypted-file"))]
pub use credentials::CredentialManager;
pub use credentials::SecretStorage;
