use crate::{HttpArgs, services::bridge::EventBridge};
use rclone_manager_core::context::AppHandle;
use std::sync::Arc;

pub fn start(
    app: &AppHandle,
    cli_args: &HttpArgs,
    event_bridge: &Arc<EventBridge>,
) -> tokio::task::JoinHandle<()> {
    let app = app.clone();
    let args = cli_args.clone();
    let bridge = event_bridge.clone();

    log::info!("Initializing Web Server on {}:{}...", args.host, args.port);

    crate::utils::spawn(async move {
        if let Err(e) = super::server::start_web_server(app.clone(), bridge, &args).await {
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
            app.exit(1);
        }
    })
}
