//! Main settings manager module
//!
//! This module contains the [`SettingsManager`] struct which is the primary entry point
//! for managing application settings.

pub mod cache;
pub mod core;
pub mod env;
pub mod events;
pub mod io;
pub mod operations;

#[cfg(feature = "hot-reload")]
pub mod hot_reload;

#[cfg(feature = "profiles")]
pub mod profiles;

// Re-export core types
pub use self::core::SettingsManager;
pub use self::events::EventManager;
#[cfg(feature = "hot-reload")]
pub use self::hot_reload::{HotReloadEvent, HotReloadRuntime};

// Builder Module
mod builder;
pub use builder::SettingsManagerBuilder;
