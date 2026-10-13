//! HTTP route composition, CORS, and frontend fallback.
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::Method,
    middleware::from_fn_with_state,
    routing::{get, post},
};
use log::info;
use tower_http::cors::{AllowOrigin, CorsLayer};
#[cfg(debug_assertions)]
use tower_http::services::{ServeDir, ServeFile};

use super::auth::{auth_middleware, create_session_handler, delete_session_handler};
use super::handlers;
use super::state::WebServerState;

pub fn build_api_router(state: WebServerState) -> Router {
    Router::new()
        .route(
            "/auth/session",
            post(create_session_handler).delete(delete_session_handler),
        )
        .merge(super::commands::generate_bridge_router())
        .route("/events", get(handlers::sse_handler))
        .route(
            "/upload",
            post(handlers::stream_upload_handler).layer(DefaultBodyLimit::disable()),
        )
        .route("/stream", get(handlers::stream_file_handler))
        .route("/stream/remote", get(handlers::stream_remote_file_handler))
        .route("/stream/audio-cover", get(handlers::audio_cover_handler))
        .with_state(state.clone())
        .layer(from_fn_with_state(state, auth_middleware))
}

pub(super) fn build_app(state: WebServerState, host: &str, port: u16) -> Router {
    let api_router = build_api_router(state.clone());

    let cors = build_cors_layer(host, port);

    let mut app = Router::new()
        .route("/health", get(handlers::health_handler))
        .nest("/api", api_router)
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http());

    #[cfg(not(debug_assertions))]
    {
        // Embedded releases always serve the UI built with this executable.
        info!("Serving embedded frontend");
        app = app.fallback_service(super::frontend::router());
    }

    #[cfg(debug_assertions)]
    match super::paths::find_static_dir(&state.app_handle) {
        Some(static_path) => {
            let index_path = static_path.join("index.html");
            let serve_dir =
                ServeDir::new(&static_path).not_found_service(ServeFile::new(index_path));
            info!("📁 Serving static files from: {}", static_path.display());
            app = app.fallback_service(serve_dir);
        }
        None => {
            info!("⚠️  No static files found. Build with: npm run build");
            app = app.route("/", get(handlers::root_handler));
        }
    }

    app
}

fn build_cors_layer(host: &str, port: u16) -> CorsLayer {
    let mut allowed_origins = vec![
        format!("http://localhost:{port}").parse().unwrap(),
        format!("http://127.0.0.1:{port}").parse().unwrap(),
    ];

    if !matches!(host, "0.0.0.0" | "127.0.0.1" | "localhost")
        && let Ok(origin) = format!("http://{host}:{port}").parse()
    {
        allowed_origins.push(origin);
    }

    #[cfg(debug_assertions)]
    {
        let dev_port = std::env::var("TAURI_DEV_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(1420);
        allowed_origins.push(format!("http://localhost:{dev_port}").parse().unwrap());
        allowed_origins.push(format!("http://127.0.0.1:{dev_port}").parse().unwrap());
    }

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
            axum::http::header::COOKIE,
        ])
        .expose_headers([axum::http::header::WWW_AUTHENTICATE])
        .allow_credentials(true)
}
