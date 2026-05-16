//! System handlers (SSE, etc.)

use axum::{
    extract::State,
    response::{Sse, sse::Event},
};
use futures::stream::Stream;
use log::info;
use std::convert::Infallible;
use tokio::sync::broadcast;

use crate::server::state::WebServerState;

// SSE
pub async fn sse_handler(
    State(state): State<WebServerState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.event_tx.subscribe();
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                    yield Ok(Event::default().data(data));
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
