//! Core configuration types and traits
//!
//! This module contains the foundational types for settings management:
//! - `SettingsConfig` - Configuration for the settings manager
//! - `SettingsSchema` - Trait for defining settings with metadata
//! - `SettingMetadata` - Rich metadata for settings (type, description, constraints)

mod schema;
mod types;

pub use schema::*;
pub use types::*;
