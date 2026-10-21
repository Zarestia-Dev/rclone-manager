//! Tauri delivery adapter. The shared event bridge only knows serialized events.
use crate::context::BackendContext;
use crate::services::bridge::event::{EventSink, FrontendEvent};
use tauri::Emitter;

pub(crate) struct WebviewEventSink(pub tauri::AppHandle);

impl EventSink for WebviewEventSink {
    fn emit(&self, frame: &FrontendEvent) {
        let event = &frame.event;
        if !crate::services::settings::access::can_deliver_event(
            self.0.backend(),
            &event.event,
            &event.payload,
            Some(frame.revision),
        ) {
            return;
        }
        let _ = self.0.emit(&event.event, &event.payload);
    }
}
