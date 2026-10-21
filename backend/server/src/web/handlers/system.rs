//! System handlers (SSE, etc.)

use std::convert::Infallible;

use axum::{
    extract::State,
    response::{Sse, sse::Event},
};
use futures::stream::Stream;
use log::info;
use tokio::sync::broadcast;

use crate::web::state::WebServerState;
use crate::{services::bridge::event::BridgeEvent, utils::types::events::SSE_FORWARD_EVENTS};

fn encode_frontend_event(event: &BridgeEvent) -> Option<String> {
    if !SSE_FORWARD_EVENTS.contains(&event.event.as_str()) {
        return None;
    }
    serde_json::to_string(event).ok()
}

pub async fn sse_handler(
    State(state): State<WebServerState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.event_bridge.subscribe_frontend();
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if !crate::services::settings::access::can_deliver_event(
                        &state.app_handle, &event.event.event, &event.event.payload, Some(event.revision)) {
                        continue;
                    }
                    if let Some(data) = encode_frontend_event(&event.event) {
                        yield Ok(Event::default().data(data));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    yield Ok(Event::default().event("error").data("{\"error\":\"event stream lagged\"}"));
                }
                Err(broadcast::error::RecvError::Closed) => { break; }
            }
        }
    };
    info!("📡 New SSE client connected");
    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declared_frontend_events_preserve_their_payloads() {
        for name in SSE_FORWARD_EVENTS {
            for payload in [json!(null), json!({}), json!({"path": "özel/a b\n.txt"})] {
                let event = BridgeEvent {
                    event: (*name).into(),
                    payload,
                };
                let encoded = encode_frontend_event(&event).unwrap();
                assert_eq!(
                    serde_json::from_str::<BridgeEvent>(&encoded).unwrap(),
                    event
                );
            }
        }
    }

    #[test]
    fn undeclared_events_stay_inside_the_backend() {
        for name in ["", "internal-only", "APP_EVENT"] {
            let event = BridgeEvent {
                event: name.into(),
                payload: json!({"internal": true}),
            };
            assert!(encode_frontend_event(&event).is_none());
        }
    }
}
