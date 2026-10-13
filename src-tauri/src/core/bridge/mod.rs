//! Bridge Module
//!
//! Provides a unified abstraction layer across desktop, mobile, and web-server targets:
//! - `#[bridge]` macro for IPC/RPC command declarations.
//! - `EventBridge` for event routing and SSE delivery without Tauri event-loop forwarders.

pub mod event;

pub use bridge_macro::bridge;
#[cfg(feature = "tray")]
pub use event::get_app_handle;
pub use event::{EventBridge, emit, init_event_bridge, subscribe};
