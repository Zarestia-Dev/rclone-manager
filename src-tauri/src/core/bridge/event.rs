//! Event Bridge
//!
//! Provides a unified event distribution system across desktop and headless (web-server) targets.
//! Bypasses Tauri's internal event loop in headless mode, streaming directly to Axum SSE clients
//! via Tokio broadcast channels, while preserving Tauri webview IPC parity on desktop.

use std::sync::Arc;

use once_cell::sync::OnceCell;
#[cfg(not(feature = "web-server"))]
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Represents an event payload distributed through the bridge
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BridgeEvent {
    pub event: String,
    pub payload: serde_json::Value,
}

static GLOBAL_EVENT_BRIDGE: OnceCell<Arc<EventBridge>> = OnceCell::new();

/// Manages event subscriptions and distribution across desktop IPC and web-server SSE.
pub struct EventBridge {
    tx: broadcast::Sender<BridgeEvent>,
    #[cfg(not(feature = "web-server"))]
    app_handle: Arc<RwLock<Option<tauri::AppHandle>>>,
}

impl EventBridge {
    /// Creates a new `EventBridge` instance with the specified channel capacity.
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            #[cfg(not(feature = "web-server"))]
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    /// Associates the desktop Tauri `AppHandle` with this bridge.
    #[cfg(not(feature = "web-server"))]
    pub fn set_app_handle(&self, app_handle: tauri::AppHandle) {
        *self.app_handle.write() = Some(app_handle);
    }

    /// Returns the associated desktop Tauri `AppHandle` if available.
    #[cfg(feature = "tray")]
    pub fn get_app_handle(&self) -> Option<tauri::AppHandle> {
        self.app_handle.read().clone()
    }

    /// Subscribes to all events emitted through this bridge.
    pub fn subscribe(&self) -> broadcast::Receiver<BridgeEvent> {
        self.tx.subscribe()
    }

    /// Emits an event across the bridge.
    ///
    /// - In headless/web-server mode: broadcasts directly to the Tokio channel (and Axum SSE).
    /// - In desktop mode: broadcasts to the Tokio channel AND Tauri's webview IPC.
    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        let value = serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null);

        let bridge_event = BridgeEvent {
            event: event.to_string(),
            payload: value,
        };

        // Broadcast to Tokio channel (consumed by web-server SSE)
        let _ = self.tx.send(bridge_event);

        // Forward to desktop webview IPC if running in desktop mode
        #[cfg(not(feature = "web-server"))]
        {
            if let Some(ref app) = *self.app_handle.read() {
                use tauri::Emitter;
                let _ = app.emit(event, payload);
            }
        }
    }
}

/// Initializes the global `EventBridge` singleton.
pub fn init_event_bridge(bridge: Arc<EventBridge>) {
    if GLOBAL_EVENT_BRIDGE.set(bridge).is_err() {
        log::warn!("Global EventBridge already initialized");
    }
}

/// Emits an event globally through the `EventBridge`.
pub fn emit<S: Serialize + Clone>(event: &str, payload: S) {
    if let Some(bridge) = GLOBAL_EVENT_BRIDGE.get() {
        bridge.emit(event, payload);
    } else {
        log::warn!("Global EventBridge not initialized, dropping event: {event}");
    }
}

/// Subscribes to events globally through the `EventBridge`.
pub fn subscribe() -> Option<broadcast::Receiver<BridgeEvent>> {
    GLOBAL_EVENT_BRIDGE.get().map(|b| b.subscribe())
}

/// Returns the associated desktop Tauri `AppHandle` if available.
#[cfg(feature = "tray")]
pub fn get_app_handle() -> Option<tauri::AppHandle> {
    GLOBAL_EVENT_BRIDGE.get().and_then(|b| b.get_app_handle())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_event_bridge_emit_and_subscribe() {
        let bridge = EventBridge::new(10);
        let mut rx = bridge.subscribe();

        bridge.emit("test_event", json!({ "key": "value", "count": 123 }));

        let received = rx.recv().await.expect("Failed to receive event");
        assert_eq!(received.event, "test_event");
        assert_eq!(received.payload["key"], "value");
        assert_eq!(received.payload["count"], 123);
    }

    #[tokio::test]
    async fn test_event_bridge_multiple_subscribers() {
        let bridge = EventBridge::new(10);
        let mut rx1 = bridge.subscribe();
        let mut rx2 = bridge.subscribe();

        bridge.emit("broadcast_event", "hello");

        let msg1 = rx1.recv().await.expect("Subscriber 1 failed");
        let msg2 = rx2.recv().await.expect("Subscriber 2 failed");

        assert_eq!(msg1.event, "broadcast_event");
        assert_eq!(msg1.payload, "hello");
        assert_eq!(msg2.event, "broadcast_event");
        assert_eq!(msg2.payload, "hello");
    }

    #[test]
    fn test_bridge_event_serialization_parity() {
        let event = BridgeEvent {
            event: "status_changed".to_string(),
            payload: json!({ "status": "ready" }),
        };

        let serialized = serde_json::to_string(&event).expect("Serialization failed");
        let deserialized: BridgeEvent =
            serde_json::from_str(&serialized).expect("Deserialization failed");

        assert_eq!(event, deserialized);
    }

    #[tokio::test]
    async fn test_event_bridge_global_subscribe_and_emit() {
        let bridge = Arc::new(EventBridge::new(10));
        init_event_bridge(bridge);

        if let Some(mut rx) = subscribe() {
            emit("global_test_event", "global_payload");
            let received = rx.recv().await.expect("Failed to receive global event");
            assert_eq!(received.event, "global_test_event");
            assert_eq!(received.payload, "global_payload");
        }
    }
}
