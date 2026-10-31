//! Event Bridge
//!
//! Provides a unified event distribution system across desktop and headless (web-server) targets.
//! Bypasses Tauri's internal event loop in headless mode, streaming directly to Axum SSE clients
//! via Tokio broadcast channels, while preserving Tauri webview IPC parity on desktop.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::sync::broadcast;

/// Represents an event payload distributed through the bridge
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BridgeEvent {
    pub event: String,
    pub payload: serde_json::Value,
}

/// Session stamp is internal and never serialized to clients.
#[derive(Clone)]
pub struct FrontendEvent {
    pub event: Arc<BridgeEvent>,
    pub revision: u64,
}

static GLOBAL_EVENT_BRIDGE: OnceLock<Arc<EventBridge>> = OnceLock::new();

/// Host adapter for delivering serialized events outside the shared broadcast channel.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &FrontendEvent);
}

/// Manages event subscriptions and distribution across desktop IPC and web-server SSE.
pub struct EventBridge {
    tx: broadcast::Sender<Arc<BridgeEvent>>,
    frontend_tx: broadcast::Sender<FrontendEvent>,
    access: parking_lot::RwLock<Option<Arc<crate::services::settings::access::VaultAccess>>>,
    sink: OnceLock<Arc<dyn EventSink>>,
}

impl EventBridge {
    /// Creates a new `EventBridge` instance with the specified channel capacity.
    pub fn new(capacity: usize, sink: Option<Arc<dyn EventSink>>) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        let (frontend_tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            frontend_tx,
            access: parking_lot::RwLock::new(None),
            sink: sink.map(OnceLock::from).unwrap_or_default(),
        }
    }

    /// Attaches the host delivery adapter once it exists, for a bridge created without one.
    /// A bridge keeps its first adapter.
    pub fn set_sink(&self, sink: Arc<dyn EventSink>) {
        let _ = self.sink.set(sink);
    }

    pub fn set_frontend_access(&self, access: Arc<crate::services::settings::access::VaultAccess>) {
        *self.access.write() = Some(access);
    }

    pub fn subscribe_frontend(&self) -> broadcast::Receiver<FrontendEvent> {
        self.frontend_tx.subscribe()
    }

    /// Subscribes to all events emitted through this bridge. Events are shared, not copied, per receiver.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<BridgeEvent>> {
        self.tx.subscribe()
    }

    /// Emits an event across the bridge.
    ///
    /// - In headless/web-server mode: broadcasts directly to the Tokio channel (and Axum SSE).
    /// - In desktop mode: broadcasts to the Tokio channel AND Tauri's webview IPC.
    pub fn emit<S: Serialize>(&self, event: &str, payload: S) {
        let value = match serde_json::to_value(&payload) {
            Ok(value) => value,
            Err(error) => {
                log::error!("Failed to serialize event {event}, dropping event: {error}");
                return;
            }
        };

        let bridge_event = Arc::new(BridgeEvent {
            event: event.to_string(),
            payload: value,
        });

        // Backend consumers always receive events, including while the UI is locked.
        let _ = self.tx.send(bridge_event.clone());
        let deliver = |revision| {
            let frontend = FrontendEvent {
                event: bridge_event.clone(),
                revision,
            };
            let _ = self.frontend_tx.send(frontend.clone());
            if let Some(sink) = self.sink.get() {
                sink.emit(&frontend);
            }
        };
        if let Some(access) = self.access.read().as_ref() {
            access.deliver(
                event == crate::utils::types::events::VAULT_STATE_CHANGED,
                deliver,
            );
        } else {
            deliver(0);
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
pub fn emit<S: Serialize>(event: &str, payload: S) {
    if let Some(bridge) = GLOBAL_EVENT_BRIDGE.get() {
        bridge.emit(event, payload);
    } else {
        log::warn!("Global EventBridge not initialized, dropping event: {event}");
    }
}

/// Subscribes to events globally through the `EventBridge`.
pub fn subscribe() -> Option<broadcast::Receiver<Arc<BridgeEvent>>> {
    GLOBAL_EVENT_BRIDGE.get().map(|b| b.subscribe())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Default)]
    struct RecordingSink(parking_lot::Mutex<Vec<BridgeEvent>>);

    impl EventSink for RecordingSink {
        fn emit(&self, event: &FrontendEvent) {
            self.0.lock().push((*event.event).clone());
        }
    }

    #[tokio::test]
    async fn host_sink_and_broadcast_receive_identical_payloads() {
        let sink = Arc::new(RecordingSink::default());
        let bridge = EventBridge::new(10, Some(sink.clone()));
        let mut receiver = bridge.subscribe();

        for payload in [json!(null), json!({}), json!({"path": "özel/a b.txt"})] {
            bridge.emit("payload", payload.clone());
            let broadcast = receiver.recv().await.unwrap();
            assert_eq!(broadcast.payload, payload);
            assert_eq!(sink.0.lock().last(), Some(&*broadcast));
        }
    }

    #[test]
    fn a_sink_attached_later_only_receives_later_events() {
        let sink = Arc::new(RecordingSink::default());
        let bridge = EventBridge::new(4, None);
        bridge.emit("before", ());
        bridge.set_sink(sink.clone());
        bridge.emit("after", ());
        assert_eq!(sink.0.lock().len(), 1);
        assert_eq!(sink.0.lock()[0].event, "after");
    }

    #[test]
    fn a_bridge_keeps_its_first_sink() {
        let (first, second) = (
            Arc::new(RecordingSink::default()),
            Arc::new(RecordingSink::default()),
        );
        let bridge = EventBridge::new(4, Some(first.clone()));
        bridge.set_sink(second.clone());
        bridge.emit("event", ());
        assert_eq!(first.0.lock().len(), 1);
        assert!(second.0.lock().is_empty());
    }

    #[test]
    fn host_delivery_does_not_require_a_broadcast_subscriber() {
        let sink = Arc::new(RecordingSink::default());
        let bridge = EventBridge::new(1, Some(sink.clone()));
        bridge.emit("ready", ());
        assert_eq!(sink.0.lock().len(), 1);
        assert_eq!(sink.0.lock()[0].payload, json!(null));
    }

    #[test]
    fn failed_serialization_is_not_delivered_to_either_transport() {
        struct InvalidPayload;
        impl Serialize for InvalidPayload {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("invalid payload"))
            }
        }

        let sink = Arc::new(RecordingSink::default());
        let bridge = EventBridge::new(1, Some(sink.clone()));
        let mut receiver = bridge.subscribe();
        bridge.emit("invalid", InvalidPayload);
        assert!(matches!(
            receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert!(sink.0.lock().is_empty());

        bridge.emit("valid", json!({"message": "özel"}));
        let event = receiver.try_recv().unwrap();
        assert_eq!(event.event, "valid");
        assert_eq!(event.payload, json!({"message": "özel"}));
        assert_eq!(sink.0.lock()[0], *event);
    }

    #[tokio::test]
    async fn test_event_bridge_emit_and_subscribe() {
        let bridge = EventBridge::new(10, None);
        let mut rx = bridge.subscribe();

        bridge.emit("test_event", json!({ "key": "value", "count": 123 }));

        let received = rx.recv().await.expect("Failed to receive event");
        assert_eq!(received.event, "test_event");
        assert_eq!(received.payload["key"], "value");
        assert_eq!(received.payload["count"], 123);
    }

    #[tokio::test]
    async fn test_event_bridge_multiple_subscribers() {
        let bridge = EventBridge::new(10, None);
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
        let bridge = Arc::new(EventBridge::new(10, None));
        init_event_bridge(bridge);

        if let Some(mut rx) = subscribe() {
            emit("global_test_event", "global_payload");
            let received = rx.recv().await.expect("Failed to receive global event");
            assert_eq!(received.event, "global_test_event");
            assert_eq!(received.payload, "global_payload");
        }
    }

    #[tokio::test]
    async fn backend_subscribers_share_one_copy_of_each_event() {
        let bridge = EventBridge::new(8, None);
        let mut first = bridge.subscribe();
        let mut second = bridge.subscribe();

        bridge.emit("shared", json!({"items": [1, 2, 3]}));

        let (first, second) = (first.recv().await.unwrap(), second.recv().await.unwrap());
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.payload, json!({"items": [1, 2, 3]}));
    }
}
