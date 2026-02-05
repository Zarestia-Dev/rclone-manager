use log::{info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::core::settings::AppSettingsManager;

// Check for updates every 4 hours
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

// Global cancellation token (AtomicBool)
// true = running, false = should stop
static IS_RUNNING: AtomicBool = AtomicBool::new(false);

/// Initialize the auto-update checker background task
pub fn init_auto_updater(app: AppHandle) {
    if IS_RUNNING.load(Ordering::SeqCst) {
        warn!("⚠️ Auto-updater is already running");
        return;
    }

    info!("🕒 Initializing auto-updater...");
    IS_RUNNING.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        // Initial delay to let the app start up fully before first check
        sleep(Duration::from_secs(10)).await;

        while IS_RUNNING.load(Ordering::SeqCst) {
            run_update_checks(&app).await;

            sleep(UPDATE_CHECK_INTERVAL).await;
        }
        info!("🛑 Auto-updater background task stopped.");
    });
}

/// Stop the auto-updater background task
pub fn stop_auto_updater() {
    if IS_RUNNING.load(Ordering::SeqCst) {
        info!("🛑 Stopping auto-updater...");
        IS_RUNNING.store(false, Ordering::SeqCst);
    }
}

async fn run_update_checks(app: &AppHandle) {
    info!("🔄 Running scheduled update checks...");

    let settings = app.state::<AppSettingsManager>();
    let config = settings.inner().get_all().unwrap_or_default();

    // Check App Updates
    if config.runtime.app_auto_check_updates {
        #[cfg(all(desktop, feature = "updater"))]
        {
            let channel = &config.runtime.app_update_channel;
            info!("🔍 Checking for App updates (channel: {})...", channel);
            if let Err(e) = check_app_update(app, channel).await {
                warn!("Failed to check for app updates: {}", e);
            }
        }
    } else {
        info!("⏭️ Skipping App update check (disabled)");
    }

    // Check Rclone Updates
    if config.runtime.rclone_auto_check_updates {
        let channel = &config.runtime.rclone_update_channel;
        info!("🔍 Checking for Rclone updates (channel: {})...", channel);

        use crate::utils::rclone::updater::check_rclone_update;
        if let Err(e) = check_rclone_update(app.clone(), Some(channel.clone())).await {
            warn!("Failed to check for rclone updates: {}", e);
        }
    } else {
        info!("⏭️ Skipping Rclone update check (disabled)");
    }
}

#[cfg(all(desktop, feature = "updater"))]
async fn check_app_update(app: &AppHandle, channel: &str) -> Result<(), String> {
    use crate::utils::app::updater::app_updates::{DownloadState, PendingUpdate, fetch_update};

    let pending_state = app.state::<PendingUpdate>();
    let download_state = app.state::<DownloadState>();

    fetch_update(
        app.clone(),
        pending_state,
        download_state,
        channel.to_string(),
    )
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}
