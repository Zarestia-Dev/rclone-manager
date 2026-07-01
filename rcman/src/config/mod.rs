//! Core configuration types and traits
//!
//! This module contains the foundational types for settings management:
//! - `SettingsConfig` - Configuration for the settings manager
//! - `SettingsSchema` - Trait for defining settings with metadata
//! - `SettingMetadata` - Rich metadata for settings (type, description, constraints)

pub mod cache;
pub mod docs;
mod schema;
mod types;

pub use schema::{
    NumberConstraints, SettingConstraints, SettingMetadata, SettingOption, SettingType,
    SettingsSchema, TextConstraints, meta, opt,
};

pub use cache::CacheStrategy;
pub use docs::{DocsConfig, generate_docs, generate_docs_from_metadata};

pub use types::{
    CredentialConfig, DefaultEnvSource, EnvSource, SettingsConfig, SettingsConfigBuilder,
};

#[cfg(feature = "hot-reload")]
pub use types::{HotReloadBackend, HotReloadConfig};
