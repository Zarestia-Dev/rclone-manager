use axum::{Router, routing::get};

use super::handlers;
use super::state::{WebServerState, auth_middleware};

pub fn build_api_router(state: WebServerState) -> Router {
    Router::new()
        // The single unified bridge endpoint
        .merge(crate::core::commands::generate_bridge_router())
        // Manual routes for streaming and events
        .route("/events", get(handlers::sse_handler))
        .route("/fs/stream", get(handlers::stream_file_handler))
        .route(
            "/fs/stream/remote",
            get(handlers::stream_remote_file_handler),
        )
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(state, auth_middleware))
}
