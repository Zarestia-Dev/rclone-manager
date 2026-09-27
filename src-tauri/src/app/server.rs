use crate::{
    core::{bridge::EventBridge, cli::CliArgs},
    utils::context::AppHandle,
};
use std::sync::Arc;

pub(super) fn start(app: &AppHandle, cli_args: &CliArgs, event_bridge: &Arc<EventBridge>) {
    use crate::server::start_web_server;

    let web_handle = app.clone();
    let args = cli_args.clone();
    let bridge = event_bridge.clone();

    log::info!(
        "Initializing Web Server on {}:{}...",
        args.headless.host,
        args.headless.port
    );

    crate::utils::spawn(async move {
        if let Err(e) = start_web_server(
            web_handle.clone(),
            bridge,
            args.headless.host.clone(),
            args.headless.port,
            args.auth_credentials(),
            args.headless.tls_cert.clone(),
            args.headless.tls_key.clone(),
        )
        .await
        {
            let msg = e.to_string();
            if msg.contains("address already in use")
                || msg.contains("os error 98")
                || msg.contains("os error 48")
            {
                log::error!(
                    "Port {} is already in use — another instance may be running. \
                         Shutting down.",
                    args.headless.port
                );
            } else {
                log::error!("Web server failed to start: {e:#}");
            }
            web_handle.exit(1);
        }
    });
}
