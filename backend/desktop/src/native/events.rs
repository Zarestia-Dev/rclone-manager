//! Tauri delivery adapter. The shared event bridge only knows serialized events.
use crate::services::bridge::event::{BridgeEvent, EventSink};
use tauri::Emitter;

pub(crate) struct WebviewEventSink(pub tauri::AppHandle);

impl EventSink for WebviewEventSink {
    fn emit(&self, event: &BridgeEvent) {
        let _ = self.0.emit(&event.event, &event.payload);
    }
}
