//! HTTP listener lifecycle and TLS transport.
use super::{routes::build_app, state::WebServerState};
use crate::services::bridge::EventBridge;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use log::info;
use rclone_manager_core::context::AppHandle;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

pub(super) async fn start_web_server(
    app_handle: AppHandle,
    event_bridge: Arc<EventBridge>,
    host: String,
    port: u16,
    auth_credentials: Option<(String, String)>,
    tls_cert: Option<std::path::PathBuf>,
    tls_key: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

    let encoded_auth = auth_credentials.map(|(username, password)| {
        let encoded = STANDARD.encode(format!("{username}:{password}").as_bytes());
        (username, encoded)
    });

    let state = WebServerState {
        app_handle: app_handle.clone(),
        event_bridge,
        auth_credentials: encoded_auth,
        sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = build_app(state.clone(), &host, port);
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse()?;

    let handle = axum_server::Handle::new();
    let listener = serve(app, addr, tls_cert, tls_key, handle.clone());
    tokio::pin!(listener);
    let ready_handle = handle.clone();
    let ready_app = app_handle.clone();
    let ready = async move {
        if ready_handle.listening().await.is_some() {
            crate::services::updates::health::host_ready(&ready_app);
        }
        std::future::pending::<()>().await;
    };
    tokio::pin!(ready);
    tokio::select! {
        _ = &mut ready => unreachable!(),
        result = &mut listener => result,
        _ = app_handle.wait_for_exit() => {
            // SSE connections may remain open indefinitely; bound their drain time.
            handle.graceful_shutdown(Some(std::time::Duration::from_secs(5)));
            listener.await
        }
    }
}

async fn serve(
    app: Router,
    addr: std::net::SocketAddr,
    tls_cert: Option<std::path::PathBuf>,
    tls_key: Option<std::path::PathBuf>,
    handle: axum_server::Handle<std::net::SocketAddr>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let (Some(cert), Some(key)) = (tls_cert, tls_key) {
        info!("🔒 TLS enabled — https://{addr}");
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = RustlsConfig::from_pem_file(cert, key)
            .await
            .map_err(|e| format!("Failed to load TLS config: {e}"))?;
        axum_server::bind_rustls(addr, config)
            .handle(handle)
            .serve(app.into_make_service())
            .await?;
    } else {
        info!("⚠️  No TLS — running over plain HTTP. Credentials are not encrypted in transit.");
        info!("🌍 Listening on http://{addr}");
        axum_server::bind(addr)
            .handle(handle)
            .serve(app.into_make_service())
            .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn http_listener_accepts_graceful_shutdown() {
        let handle = axum_server::Handle::new();
        let listener = serve(
            Router::new(),
            "127.0.0.1:0".parse().unwrap(),
            None,
            None,
            handle.clone(),
        );
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(listener, async {
                assert!(handle.listening().await.is_some());
                handle.graceful_shutdown(Some(Duration::from_secs(1)));
            })
            .0
        })
        .await
        .expect("listener did not stop");
        result.unwrap();
    }

    #[tokio::test]
    async fn occupied_port_preserves_typed_io_error() {
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(3),
            serve(
                Router::new(),
                occupied.local_addr().unwrap(),
                None,
                None,
                axum_server::Handle::new(),
            ),
        )
        .await
        .expect("binding an occupied port should return promptly")
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::AddrInUse,
        );
    }

    #[tokio::test]
    async fn invalid_tls_files_return_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let result = serve(
            Router::new(),
            "127.0.0.1:0".parse().unwrap(),
            Some(temp.path().join("missing.crt")),
            Some(temp.path().join("missing.key")),
            axum_server::Handle::new(),
        )
        .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Failed to load TLS config")
        );
    }
}
