use crate::{HttpArgs, services::bridge::EventBridge};
use rclone_manager_core::context::AppHandle;
use std::sync::Arc;

pub fn start(
    app: &AppHandle,
    cli_args: &HttpArgs,
    event_bridge: &Arc<EventBridge>,
) -> tokio::task::JoinHandle<()> {
    use super::server::start_web_server;

    let web_handle = app.clone();
    let args = cli_args.clone();
    let bridge = event_bridge.clone();

    log::info!("Initializing Web Server on {}:{}...", args.host, args.port);

    crate::utils::spawn(async move {
        if let Err(e) = start_web_server(
            web_handle.clone(),
            bridge,
            args.host.clone(),
            args.port,
            args.auth_credentials(),
            args.tls_cert.clone(),
            args.tls_key.clone(),
        )
        .await
        {
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::AddrInUse)
            {
                log::error!(
                    "Port {} is already in use — another instance may be running. \
                         Shutting down.",
                    args.port
                );
            } else {
                log::error!("Web server failed to start: {e:#}");
            }
            web_handle.exit(1);
        }
    })
}
