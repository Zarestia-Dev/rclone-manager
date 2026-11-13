//! HTTP route composition, CORS, and frontend fallback.
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method},
    middleware::from_fn_with_state,
    routing::{get, post},
};
use log::info;
use tower_http::cors::{AllowOrigin, CorsLayer};

use super::auth::{auth_middleware, create_session_handler, delete_session_handler};
use super::handlers;
use super::state::WebServerState;

pub fn build_api_router(state: WebServerState) -> Router {
    let files = Router::new()
        .route(
            "/upload",
            post(handlers::stream_upload_handler).layer(DefaultBodyLimit::disable()),
        )
        .route("/stream", get(handlers::stream_file_handler))
        .route("/stream/remote", get(handlers::stream_remote_file_handler))
        .route("/stream/audio-cover", get(handlers::audio_cover_handler))
        .route_layer(from_fn_with_state(
            state.clone(),
            super::access::file_access_middleware,
        ));
    Router::new()
        .route(
            "/auth/session",
            post(create_session_handler).delete(delete_session_handler),
        )
        .merge(super::commands::generate_bridge_router())
        .route("/events", get(handlers::sse_handler))
        .merge(files)
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
    match dev_frontend_dir(&state.app_handle) {
        Some(static_path) => {
            info!("📁 Serving static files from: {}", static_path.display());
            app = app.fallback_service(development_router(static_path));
        }
        None => {
            info!("⚠️  No static files found. Build with: npm run build");
            app = app.route("/", get(handlers::root_handler));
        }
    }

    app
}

/// Port of the Angular development server, which calls this API cross-origin.
#[cfg(debug_assertions)]
pub(super) fn dev_server_port() -> u16 {
    std::env::var("TAURI_DEV_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(1420)
}

fn build_cors_layer(host: &str, port: u16) -> CorsLayer {
    let mut origins = vec![
        format!("http://localhost:{port}"),
        format!("http://127.0.0.1:{port}"),
        super::address::browser_origin(host, port, false),
    ];

    #[cfg(debug_assertions)]
    {
        let dev_port = dev_server_port();
        origins.push(format!("http://localhost:{dev_port}"));
        origins.push(format!("http://127.0.0.1:{dev_port}"));
    }

    origins.sort_unstable();
    origins.dedup();
    let allowed_origins: Vec<_> = origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect();

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

/// Debug builds read the frontend from disk instead of the embedded copy.
#[cfg(debug_assertions)]
fn dev_frontend_dir(app: &rclone_manager_core::context::AppHandle) -> Option<std::path::PathBuf> {
    [
        app.state::<crate::services::paths::AppPaths>()
            .resource_dir
            .join("browser"),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist/rclone-manager/browser"),
    ]
    .into_iter()
    .find(|path| path.is_dir())
}

/// Disk-backed development builds use the same client-route policy as embedded releases.
#[cfg(debug_assertions)]
fn development_router(path: std::path::PathBuf) -> Router {
    use axum::{
        extract::Request,
        middleware::{Next, from_fn},
    };
    use axum::{http::StatusCode, response::IntoResponse};
    use tower_http::services::{ServeDir, ServeFile};
    let fallback = Router::new()
        .fallback_service(ServeFile::new(path.join("index.html")))
        .layer(from_fn(|request: Request, next: Next| async move {
            let is_route = percent_encoding::percent_decode_str(request.uri().path())
                .decode_utf8()
                .is_ok_and(|path| is_client_route(path.trim_start_matches('/')));
            if !is_route {
                return StatusCode::NOT_FOUND.into_response();
            }
            next.run(request).await
        }));
    Router::new().fallback_service(ServeDir::new(path).fallback(fallback))
}

pub(super) fn is_client_route(path: &str) -> bool {
    !path.split('/').any(|part| part == ".." || part == ".")
        && !path.contains(['\\', '\0'])
        && path != "api"
        && !path.starts_with("api/")
        && path != "assets"
        && !path.starts_with("assets/")
        && !path.rsplit('/').next().unwrap_or("").contains('.')
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[test]
    fn client_routes_exclude_api_assets_files_and_traversal() {
        for path in ["", "settings", "nautilus/dropbox"] {
            assert!(is_client_route(path), "{path:?}");
        }
        for path in [
            "api", "api/x", "assets", "assets/x", "main.js", "a/../b", "./a", "a\\b", "a\0b",
        ] {
            assert!(!is_client_route(path), "{path:?}");
        }
    }

    #[tokio::test]
    async fn development_routes_return_200_without_masking_missing_assets_or_api() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "<app-root></app-root>").unwrap();
        let app = development_router(directory.path().to_owned());
        for (path, expected) in [
            ("/nautilus/dropbox", StatusCode::OK),
            ("/settings", StatusCode::OK),
            ("/missing.js", StatusCode::NOT_FOUND),
            ("/assets/missing", StatusCode::NOT_FOUND),
            ("/api/missing", StatusCode::NOT_FOUND),
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{path}");
            if expected == StatusCode::OK {
                assert_eq!(
                    to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap()
                        .as_ref(),
                    b"<app-root></app-root>"
                );
            }
        }
    }
}
