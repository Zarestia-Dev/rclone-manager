use crate::{services, utils};

pub fn run() {
    let cli_args =
        <crate::cli::CliArgs as clap::Parser>::try_parse().unwrap_or_else(|error| error.exit());
    if let Err(error) = cli_args.validate() {
        eprintln!("Invalid CLI arguments: {error}");
        std::process::exit(1);
    }
    let app = rclone_manager_core::context::AppHandle::new(
        std::sync::Arc::new(ServerHost),
        crate::PRODUCT,
    );
    app.manage(cli_args.general.clone());
    if let Err(error) = rclone_manager_core::app::setup_context(&app, None) {
        eprintln!("Failed to initialize application: {error}");
        std::process::exit(1);
    }
    let server = crate::start(
        &app,
        &cli_args.headless,
        app.state::<std::sync::Arc<services::bridge::EventBridge>>()
            .inner(),
    );
    rclone_manager_core::app::send_to::start(&app, cli_args.general);
    let code = utils::block_on(wait_for_shutdown(&app, shutdown_signal()));
    utils::block_on(async {
        if tokio::time::timeout(
            std::time::Duration::from_secs(20),
            services::lifecycle::shutdown::handle_shutdown(app.clone()),
        )
        .await
        .is_err()
        {
            log::error!("Application cleanup exceeded shutdown deadline");
        }
        let mut server = server;
        match tokio::time::timeout(std::time::Duration::from_secs(6), &mut server).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::error!("HTTP task failed: {error}"),
            Err(_) => {
                server.abort();
                log::warn!("HTTP shutdown exceeded deadline");
            }
        }
    });
    std::process::exit(code);
}

struct ServerHost;
#[async_trait::async_trait]
impl rclone_manager_core::context::Host for ServerHost {
    fn update_method(&self) -> services::updates::policy::UpdateMethod {
        services::updates::policy::UpdateMethod::Binary
    }
    fn resolve_paths(
        &self,
        app: &rclone_manager_core::context::AppHandle,
    ) -> Result<services::paths::AppPaths, String> {
        super::paths::resolve_paths(app)
    }
    fn restart(&self, app: &rclone_manager_core::context::AppHandle) -> Result<(), String> {
        super::lifecycle::restart(app)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::CliArgs;
    use clap::Parser;
    use rclone_manager_core::services::paths::AppPaths;

    #[test]
    fn headless_paths_respect_cli_overrides_and_create_directories() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data with spaces");
        let cache = temp.path().join("cache");
        let logs = temp.path().join("logs");
        let args = CliArgs::try_parse_from([
            "server",
            "--data-dir",
            data.to_str().unwrap(),
            "--cache-dir",
            cache.to_str().unwrap(),
            "--logs-dir",
            logs.to_str().unwrap(),
        ])
        .unwrap();
        let app = rclone_manager_core::context::AppHandle::new(
            std::sync::Arc::new(ServerHost),
            crate::PRODUCT,
        );
        app.manage(args.general);
        let paths = AppPaths::setup(&app).unwrap();
        assert_eq!(paths.config_dir, data);
        assert_eq!(paths.cache_dir, cache);
        assert_eq!(paths.logs_dir, logs);
        assert!(data.is_dir());
        assert!(paths.get_app_log_dir().is_dir());
        assert!(paths.get_rclone_log_dir().is_dir());
    }
}

/// Signals belong to the standalone process, never the embedded HTTP server.
async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        tokio::select! {
            _ = terminate.recv() => {},
            _ = interrupt.recv() => {},
        }
        Ok(())
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}

async fn wait_for_shutdown(
    app: &rclone_manager_core::context::AppHandle,
    signal: impl std::future::Future<Output = std::io::Result<()>>,
) -> i32 {
    tokio::select! {
        code = app.wait_for_exit() => code,
        result = signal => {
            let code = if let Err(error) = result {
                log::error!("Failed to listen for shutdown signal: {error}");
                1
            } else { 0 };
            app.exit(code);
            app.wait_for_exit().await
        }
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::wait_for_shutdown;
    use rclone_manager_core::context::AppHandle;

    #[tokio::test]
    async fn signal_requests_exit_and_retains_code() {
        let app = AppHandle::default();
        assert_eq!(wait_for_shutdown(&app, async { Ok(()) }).await, 0);
        assert_eq!(app.wait_for_exit().await, 0);
    }

    #[tokio::test]
    async fn signal_registration_failure_requests_error_exit() {
        let app = AppHandle::default();
        assert_eq!(
            wait_for_shutdown(&app, async { Err(std::io::Error::other("unavailable")) }).await,
            1
        );
        assert_eq!(app.wait_for_exit().await, 1);
    }

    #[tokio::test]
    async fn application_exit_does_not_require_a_signal() {
        let app = AppHandle::default();
        app.exit(7);
        assert_eq!(wait_for_shutdown(&app, std::future::pending()).await, 7);
    }
}
