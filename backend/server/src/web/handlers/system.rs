//! System handlers (SSE, etc.)

use std::{convert::Infallible, time::Duration};

use axum::{
    Extension,
    extract::State,
    response::{Sse, sse::Event},
};
use futures::stream::Stream;
use log::{info, warn};
use tokio::sync::broadcast;

use crate::web::auth::{SESSION_RECHECK, SessionToken, session_ended};
use crate::web::state::WebServerState;
use crate::{services::bridge::event::BridgeEvent, utils::types::events::SSE_FORWARD_EVENTS};

fn is_forwarded(event: &BridgeEvent) -> bool {
    SSE_FORWARD_EVENTS.contains(&event.event.as_str())
}

pub async fn sse_handler(
    State(state): State<WebServerState>,
    session: Option<Extension<SessionToken>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    info!("📡 New SSE client connected");
    Sse::new(event_stream(
        state,
        session.map(|Extension(token)| token),
        SESSION_RECHECK,
    ))
    .keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

/// Frontend events for one client. A stream opened by a session ends once that
/// session is logged out or expires.
fn event_stream(
    state: WebServerState,
    session: Option<SessionToken>,
    recheck_every: Duration,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let mut rx = state.event_bridge.subscribe_frontend();
    async_stream::stream! {
        let ended = session_ended(state.clone(), session, recheck_every);
        tokio::pin!(ended);
        loop {
            tokio::select! {
                received = rx.recv() => match received {
                    Ok(event) => {
                        if is_forwarded(&event.event)
                            && crate::services::settings::access::can_deliver_event(
                                &state.app_handle,
                                &event.event.event,
                                &event.event.payload,
                                Some(event.revision),
                            )
                            && let Some(json) = event.json()
                        {
                            yield Ok(Event::default().data(json));
                        }
                    }
                    // Events were dropped, so state may be stale. Closing the stream
                    // makes the client reconnect and reload what it shows.
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        warn!("SSE client lagged by {missed} events; closing so it resyncs");
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = &mut ended => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use rclone_manager_core::{
        context::AppHandle,
        services::bridge::{EventBridge, event::FrontendEvent},
    };
    use serde_json::json;
    use std::sync::Arc;

    fn state() -> WebServerState {
        WebServerState::new(
            AppHandle::default(),
            Arc::new(EventBridge::new(2, None)),
            Some("secret".into()),
            false,
        )
    }

    #[tokio::test]
    async fn a_stream_ends_when_its_session_is_revoked() {
        let state = state();
        state.sessions.write().await.insert(
            "token".into(),
            std::time::Instant::now() + Duration::from_secs(60),
        );
        let mut stream = Box::pin(event_stream(
            state.clone(),
            Some(SessionToken("token".into())),
            Duration::from_millis(10),
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), stream.next())
                .await
                .is_err(),
            "a live session keeps the stream open"
        );
        state.sessions.write().await.remove("token");
        let ended = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("stream should notice the logout");
        assert!(ended.is_none());
    }

    #[tokio::test]
    async fn a_stream_closes_after_missing_events_so_the_client_resyncs() {
        let state = state();
        let mut stream = Box::pin(event_stream(state.clone(), None, Duration::from_secs(60)));
        // Subscribe happens when the stream is created; overflow the 2-slot channel.
        for _ in 0..5 {
            state
                .event_bridge
                .emit(SSE_FORWARD_EVENTS[0], json!({"n": 1}));
        }
        let first = stream.next().await;
        assert!(first.is_none(), "lagged receivers must end the stream");
    }

    #[test]
    fn declared_frontend_events_preserve_their_payloads() {
        for name in SSE_FORWARD_EVENTS {
            for payload in [json!(null), json!({}), json!({"path": "özel/a b\n.txt"})] {
                let event = BridgeEvent {
                    event: (*name).into(),
                    payload,
                };
                assert!(is_forwarded(&event));
                let frame = FrontendEvent::new(Arc::new(event.clone()), 0);
                assert_eq!(
                    serde_json::from_str::<BridgeEvent>(frame.json().unwrap()).unwrap(),
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
            assert!(!is_forwarded(&event));
        }
    }
}
