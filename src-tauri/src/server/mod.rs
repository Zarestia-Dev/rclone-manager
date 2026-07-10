pub mod handlers;
mod routes;
mod state;

pub use routes::*;
pub use state::*;

use std::{collections::HashSet, sync::Arc};

use axum::{Router, http::Method, routing::get};
use axum_server::tls_rustls::RustlsConfig;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use log::info;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{RwLock, broadcast};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::utils::types::events::SSE_FORWARD_EVENTS;

pub async fn start_web_server(
    app_handle: AppHandle,
    host: String,
    port: u16,
    auth_credentials: Option<(String, String)>,
    tls_cert: Option<std::path::PathBuf>,
    tls_key: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    info!("🌐 Starting web server on {host}:{port}");

    #[cfg(debug_assertions)]
    {
        let dev_port = std::env::var("TAURI_DEV_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(1420);
        info!("🔧 Development mode detected!");
        info!("   → Angular dev server: http://localhost:{dev_port} (with hot reload)");
        info!("   → API server: http://localhost:{port}/api");
    }

    let (event_tx, _) = broadcast::channel::<TauriEvent>(100);
    let event_tx = Arc::new(event_tx);

    register_sse_forwarders(&app_handle, &event_tx);

    let encoded_auth = auth_credentials.map(|(username, password)| {
        let encoded = STANDARD.encode(format!("{username}:{password}").as_bytes());
        (username, encoded)
    });

    let state = WebServerState {
        app_handle: app_handle.clone(),
        event_tx,
        auth_credentials: encoded_auth,
        sessions: Arc::new(RwLock::new(HashSet::new())),
    };

    let static_dir = find_static_dir(&app_handle);
    let app = build_app(state.clone(), static_dir, &host, port);
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse()?;

    serve(app, addr, tls_cert, tls_key).await
}

fn register_sse_forwarders(app_handle: &AppHandle, event_tx: &Arc<broadcast::Sender<TauriEvent>>) {
    for &event_name in SSE_FORWARD_EVENTS {
        let event_tx_for_listener = event_tx.clone();
        let event_name_owned = event_name.to_string();
        app_handle.listen(event_name, move |event| {
            let payload_str = event.payload();
            let payload_val: serde_json::Value = serde_json::from_str(payload_str)
                .unwrap_or_else(|_| serde_json::Value::String(payload_str.to_string()));

            let _ = event_tx_for_listener.send(TauriEvent {
                event: event_name_owned.clone(),
                payload: payload_val,
            });
        });
    }
}

async fn serve(
    app: Router,
    addr: std::net::SocketAddr,
    tls_cert: Option<std::path::PathBuf>,
    tls_key: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let (Some(cert), Some(key)) = (tls_cert, tls_key) {
        info!("🔒 TLS enabled — https://{addr}");
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = RustlsConfig::from_pem_file(cert, key)
            .await
            .map_err(|e| format!("Failed to load TLS config: {e}"))?;
        axum_server::bind_rustls(addr, config)
            .serve(app.into_make_service())
            .await?;
    } else {
        info!("⚠️  No TLS — running over plain HTTP. Credentials are not encrypted in transit.");
        info!("🌍 Listening on http://{addr}");
        axum_server::bind(addr)
            .serve(app.into_make_service())
            .await?;
    }

    Ok(())
}

fn find_static_dir(app_handle: &AppHandle) -> Option<std::path::PathBuf> {
    let resource_path = app_handle
        .path()
        .resolve("browser", BaseDirectory::Resource);

    if let Ok(path) = resource_path
        && path.exists()
    {
        return Some(path);
    }

    let candidates = [
        std::path::PathBuf::from("/usr/lib/rclone-manager-headless/browser"),
        std::path::PathBuf::from("dist/rclone-manager/browser"),
    ];

    for path in &candidates {
        if path.exists() {
            info!("📁 Static files: {}", path.display());
            return Some(path.clone());
        }
    }

    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent()
                .map(|p| p.join("../../../dist/rclone-manager/browser"))
        })
        .filter(|p| p.exists())
        .inspect(|p| info!("📁 Static files: {}", p.display()))
}

fn build_app(
    state: WebServerState,
    static_dir: Option<std::path::PathBuf>,
    host: &str,
    port: u16,
) -> Router {
    let api_router = build_api_router(state.clone());

    let cors = build_cors_layer(host, port);

    let mut app = Router::new()
        .route("/health", get(handlers::health_handler))
        .nest("/api", api_router)
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http());

    match static_dir {
        Some(static_path) => {
            let index_path = static_path.join("index.html");
            let serve_dir =
                ServeDir::new(&static_path).not_found_service(ServeFile::new(index_path));
            info!("📁 Serving static files from: {}", static_path.display());
            app = app.fallback_service(serve_dir);
        }
        None => {
            info!("⚠️  No static files found. Build with: npm run build:headless");
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
