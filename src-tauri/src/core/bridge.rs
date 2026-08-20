//! Bridge Attribute Macro
//!
//! Provides a unified `#[bridge]` attribute to replace raw `#[tauri::command]` annotations.
//! This encapsulates RPC/IPC command declarations across desktop and web-server targets,
//! serving as a clean abstraction layer for future doc/schema generation.

pub use bridge_macro::bridge;
