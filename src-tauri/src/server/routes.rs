use axum::{Router, routing::get};

use super::handlers;
use super::state::{
    WebServerState, auth_middleware, create_session_handler, delete_session_handler,
};

pub fn build_api_router(state: WebServerState) -> Router {
    Router::new()
        .route(
            "/auth/session",
            axum::routing::post(create_session_handler).delete(delete_session_handler),
        )
        // Unified command bridge
        .merge(crate::core::commands::generate_bridge_router())
        // Streaming and event routes
        .route("/events", get(handlers::sse_handler))
        .route(
            "/upload",
            axum::routing::post(handlers::stream_upload_handler)
                .layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/stream", get(handlers::stream_file_handler))
        .route("/stream/remote", get(handlers::stream_remote_file_handler))
        .route("/stream/audio-cover", get(handlers::audio_cover_handler))
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(state, auth_middleware))
}
