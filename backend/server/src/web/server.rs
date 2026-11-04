//! HTTP listener lifecycle and TLS transport.
use super::{address::is_loopback_host, routes::build_app, state::WebServerState};
use crate::{HttpArgs, services::bridge::EventBridge};
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use log::info;
use rclone_manager_core::context::AppHandle;
use std::{path::PathBuf, sync::Arc};

pub(super) async fn start_web_server(
    app_handle: AppHandle,
    event_bridge: Arc<EventBridge>,
    args: &HttpArgs,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (host, port) = (args.host.as_str(), args.port);
    info!("🌐 Starting web server on {host}:{port}");

    #[cfg(debug_assertions)]
    {
        let dev_port = super::routes::dev_server_port();
        info!("🔧 Development mode detected!");
        info!("   → Angular dev server: http://localhost:{dev_port} (with hot reload)");
        info!("   → API server: http://localhost:{port}/api");
    }

    let basic_auth = args
        .auth_credentials()
        .map(|(username, password)| STANDARD.encode(format!("{username}:{password}")));
    if basic_auth.is_none() && !is_loopback_host(host) {
        log::warn!(
            "No Basic Authentication configured while listening on '{host}': anyone who can reach \
             this port can run commands and read files. Set RCLONE_MANAGER_USER/RCLONE_MANAGER_PASS \
             or put the server behind an authenticating reverse proxy."
        );
    }

    let state = WebServerState::new(
        app_handle.clone(),
        event_bridge,
        basic_auth,
        args.tls_paths().is_some(),
    );
    let app = build_app(state, host, port);
    let addr = super::address::listen_address(host, port)?;

    let handle = axum_server::Handle::new();
    // The handle reports once the socket is bound; a failed bind never does.
    let ready_handle = handle.clone();
    let ready_app = app_handle.clone();
    let ready = crate::utils::spawn(async move {
        if ready_handle.listening().await.is_some() {
            crate::services::updates::health::host_ready(&ready_app);
            // Only the instance that owns the port may discard leftovers of a crash.
            super::handlers::clear_stale_upload_staging(&ready_app).await;
        }
    });
    let listener = serve(
        app,
        addr,
        args.tls_paths()
            .map(|(cert, key)| (cert.clone(), key.clone())),
        handle.clone(),
    );
    tokio::pin!(listener);
    let result = tokio::select! {
        result = &mut listener => result,
        _ = app_handle.wait_for_exit() => {
            // SSE connections may remain open indefinitely; bound their drain time.
            handle.graceful_shutdown(Some(std::time::Duration::from_secs(5)));
            listener.await
        }
    };
    ready.abort();
    result
}

async fn serve(
    app: Router,
    addr: std::net::SocketAddr,
    tls: Option<(PathBuf, PathBuf)>,
    handle: axum_server::Handle<std::net::SocketAddr>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some((cert, key)) = tls {
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
            Some((
                temp.path().join("missing.crt"),
                temp.path().join("missing.key"),
            )),
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
