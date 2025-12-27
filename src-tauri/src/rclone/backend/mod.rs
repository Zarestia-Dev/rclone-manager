// Backend abstraction layer for multi-backend support
//
// This module provides the core types and traits for managing
// multiple rclone backends (local and remote).

mod manager;
pub mod types;

pub use manager::{BACKEND_MANAGER, BackendManager};
