pub mod handlers;
mod routes;
mod state;

pub use routes::*;
pub use state::*;

use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use log::info;
use std::sync::Arc;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::utils::types::events::*;

pub async fn start_web_server(
    app_handle: AppHandle,
    host: String,
    port: u16,
    auth_credentials: Option<(String, String)>,
    tls_cert: Option<std::path::PathBuf>,
    tls_key: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    info!("🌐 Starting web server on {}:{}", host, port);

    #[cfg(debug_assertions)]
    {
        let dev_port = std::env::var("TAURI_DEV_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(1420);
        info!("🔧 Development mode detected!");
        info!(
            "   → Angular dev server: http://localhost:{} (with hot reload)",
            dev_port
        );
        info!("   → API server: http://localhost:{}/api", port);
        info!("   → Use Angular dev server for faster development with hot reload");
    }

    let (event_tx, _) = broadcast::channel::<TauriEvent>(100);
    let event_tx = Arc::new(event_tx);

    // Auto-forward all events to SSE clients, except desktop-only events
    // This ensures new events are automatically available to headless clients
    let all_events = vec![
        RCLONE_API_URL_UPDATED,
        ENGINE_RESTARTED,
        RCLONE_ENGINE_READY,
        RCLONE_ENGINE_ERROR,
        RCLONE_ENGINE_PASSWORD_ERROR,
        RCLONE_ENGINE_PATH_ERROR,
        RCLONE_ENGINE_UPDATING,
        RCLONE_PASSWORD_STORED,
        REMOTE_STATE_CHANGED,
        REMOTE_PRESENCE_CHANGED,
        REMOTE_CACHE_UPDATED,
        SYSTEM_SETTINGS_CHANGED,
        BANDWIDTH_LIMIT_CHANGED,
        RCLONE_CONFIG_UNLOCKED,
        UPDATE_TRAY_MENU,
        JOB_CACHE_CHANGED,
        MOUNT_STATE_CHANGED,
        SERVE_STATE_CHANGED,
        MOUNT_PLUGIN_INSTALLED,
        NETWORK_STATUS_CHANGED,
        SCHEDULED_TASK_ERROR,
        SCHEDULED_TASK_COMPLETED,
        SCHEDULED_TASK_STOPPED,
        APP_EVENT,
        OPEN_INTERNAL_ROUTE,
    ];

    // Events to exclude from SSE forwarding (desktop-only events)
    let excluded_events: Vec<&str> = vec![
        // Add desktop-only events here if needed
        // Example: "window_focus_changed", "tray_icon_clicked"
    ];

    let events_to_forward: Vec<&str> = all_events
        .into_iter()
        .filter(|event| !excluded_events.contains(event))
        .collect();

    for event_name in events_to_forward {
        let event_tx_for_listener = event_tx.clone();
        let event_name_owned = event_name.to_string();
        app_handle.listen(event_name, move |event| {
            let payload_str = event.payload();
            let payload_val: serde_json::Value = match serde_json::from_str(payload_str) {
                Ok(v) => v,
                Err(_) => serde_json::Value::String(payload_str.to_string()),
            };

            let tauri_event = TauriEvent {
                event: event_name_owned.clone(),
                payload: payload_val,
            };

            let _ = event_tx_for_listener.send(tauri_event);
        });
    }

    // Encode credentials for Basic Authentication
    let encoded_auth = auth_credentials.map(|(username, password)| {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let credentials = format!("{}:{}", username, password);
        let encoded = STANDARD.encode(credentials.as_bytes());
        (username, encoded)
    });

    let state = WebServerState {
        app_handle: app_handle.clone(),
        event_tx,
        auth_credentials: encoded_auth,
    };

    // Determine static files path
    let static_dir = find_static_dir(&app_handle);

    // Build the application router
    let app = build_app(state.clone(), static_dir, &host, port);

    let addr = format!("{}:{}", host, port).parse()?;

    // Start server with or without TLS
    if let (Some(cert), Some(key)) = (tls_cert, tls_key) {
        info!("🔒 SSL/TLS Enabled");
        info!("📜 Certificate: {:?}", cert);
        info!("🔑 Key: {:?}", key);
        info!("🌍 Secure Server listening on https://{}", addr);

        // Install the ring crypto provider for rustls
        let _ = rustls::crypto::ring::default_provider().install_default();

        let config = RustlsConfig::from_pem_file(cert, key)
            .await
            .map_err(|e| format!("Failed to load TLS config: {}", e))?;

        axum_server::bind_rustls(addr, config)
            .serve(app.into_make_service())
            .await?;
    } else {
        info!("⚠️  TLS keys not provided - Running in INSECURE HTTP mode");
        info!("🌍 Server listening on http://{}", addr);

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
    info!("Looking for static files in resources: {:?}", resource_path);

    if let Ok(path) = resource_path {
        if path.exists() {
            info!("✅ Found static files in resources: {}", path.display());
            return Some(path);
        }
    }

    let docker_path = std::path::PathBuf::from("/usr/lib/rclone-manager-headless/browser");
    if docker_path.exists() {
        info!(
            "✅ Found static files in Docker path: {}",
            docker_path.display()
        );
        return Some(docker_path);
    }

    let local_dist = std::path::PathBuf::from("dist/rclone-manager/browser");
    if local_dist.exists() {
        info!(
            "✅ Found static files in current directory: {}",
            local_dist.display()
        );
        return Some(local_dist);
    }

    std::env::current_exe()
        .ok()
        .and_then(|exe_path| exe_path.parent().map(|p| p.to_path_buf()))
        .and_then(|exe_dir| {
            let dist_path = exe_dir.join("../../../dist/rclone-manager/browser");
            if dist_path.exists() {
                info!(
                    "✅ Found static files relative to executable: {}",
                    dist_path.display()
                );
                Some(dist_path)
            } else {
                None
            }
        })
}

fn build_app(
    state: WebServerState,
    static_dir: Option<std::path::PathBuf>,
    host: &str,
    port: u16,
) -> Router {
    use axum::http::Method;
    use axum::routing::get;

    let api_router = build_api_router(state.clone());

    // Configure CORS
    let mut allowed_origins = vec![
        format!("http://localhost:{}", port).parse().unwrap(),
        format!("http://127.0.0.1:{}", port).parse().unwrap(),
    ];
    if host != "0.0.0.0" && host != "127.0.0.1" && host != "localhost" {
        if let Ok(origin) = format!("http://{}:{}", host, port).parse() {
            allowed_origins.push(origin);
        }
    }

    #[cfg(debug_assertions)]
    {
        let dev_port = std::env::var("TAURI_DEV_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(1420);
        info!(
            "🔧 Development mode: allowing Angular dev server on port {}",
            dev_port
        );
        allowed_origins.push(format!("http://localhost:{}", dev_port).parse().unwrap());
        allowed_origins.push(format!("http://127.0.0.1:{}", dev_port).parse().unwrap());
    }

    let cors = CorsLayer::new()
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
        ])
        .expose_headers([axum::http::header::WWW_AUTHENTICATE])
        .allow_credentials(true);

    let mut app = Router::new()
        .route("/health", get(handlers::health_handler))
        .nest("/api", api_router)
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http());

    if let Some(static_path) = static_dir {
        info!("📁 Serving static files from: {}", static_path.display());
        use tower_http::services::ServeDir;
        app = app.fallback_service(ServeDir::new(static_path));
    } else {
        info!("⚠️  No static files found. Build Angular app with: npm run build:headless");
        app = app.route("/", get(handlers::root_handler));
    }

    app
}
