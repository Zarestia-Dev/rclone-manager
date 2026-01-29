// Backend abstraction layer for multi-backend support
//
// This module provides the core types and traits for managing
// multiple rclone backends (local and remote).

pub mod cache;
pub mod connectivity;
pub mod manager;
pub mod runtime;
pub mod state;
pub mod types;

pub use manager::BackendManager;
