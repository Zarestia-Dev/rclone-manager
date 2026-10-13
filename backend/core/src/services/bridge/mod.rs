//! Bridge Module
//!
//! Provides a unified abstraction layer across desktop, mobile, and web-server targets:
//! - `EventBridge` for event routing and SSE delivery without Tauri event-loop forwarders.

pub mod event;

pub use event::{EventBridge, emit, init_event_bridge, subscribe};
