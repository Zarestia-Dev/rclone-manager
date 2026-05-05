use log::{info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::core::settings::AppSettingsManager;

/// How often to poll for updates in the background.
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

/// Global running flag — true while the background task is alive.
static IS_RUNNING: AtomicBool = AtomicBool::new(false);

/// Starts the auto-update background task (no-op if already running).
pub fn init_auto_updater(app: AppHandle) {
    if IS_RUNNING.swap(true, Ordering::AcqRel) {
        warn!("Auto-updater is already running");
        return;
    }

    info!(
        "Initializing auto-updater (interval: {}h)",
        UPDATE_CHECK_INTERVAL.as_secs() / 3600
    );

    tauri::async_runtime::spawn(async move {
        // Run initial check immediately on startup
        run_update_checks(&app).await;

        while IS_RUNNING.load(Ordering::Acquire) {
            sleep(UPDATE_CHECK_INTERVAL).await;
            run_update_checks(&app).await;
        }

        info!("Auto-updater stopped.");
    });
}

/// Signals the background task to exit on its next iteration.
pub fn stop_auto_updater() {
    IS_RUNNING.store(false, Ordering::Release);
}

async fn run_update_checks(app: &AppHandle) {
    info!("Running scheduled update checks...");

    let config = app
        .state::<AppSettingsManager>()
        .get_all()
        .unwrap_or_default();

    #[cfg(desktop)]
    if config.runtime.app_auto_check_updates {
        let channel = config.runtime.app_update_channel.clone();
        info!("Checking for app updates (channel: {channel})...");
        if let Err(e) = check_app_update(app, &channel).await {
            warn!("App update check failed: {e}");
        }
    }

    if config.runtime.rclone_auto_check_updates {
        let channel = config.runtime.rclone_update_channel.clone();
        info!("Checking for rclone updates (channel: {channel})...");
        if let Err(e) =
            crate::utils::rclone::updater::check_rclone_update(app.clone(), Some(channel)).await
        {
            warn!("Rclone update check failed: {e}");
        }
    }
}

#[cfg(desktop)]
async fn check_app_update(app: &AppHandle, channel: &str) -> Result<(), String> {
    crate::utils::app::updater::app_updates::fetch_update(app.clone(), channel.to_string())
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}
