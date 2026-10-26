use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::context::AppHandle;
use log::{debug, info, warn};
use tokio::time::sleep;

use crate::services::settings::AppSettingsManager;

/// How often to poll for updates in the background.
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
/// How soon to retry when settings (e.g. a locked vault) prevented the last check.
const UNAVAILABLE_RETRY_INTERVAL: Duration = Duration::from_secs(60);

/// Starts the auto-update background task (no-op if already running).
pub fn init_auto_updater(app: AppHandle) {
    if app
        .state::<crate::utils::types::state::RcloneState>()
        .updater_running
        .swap(true, Ordering::AcqRel)
    {
        warn!("Auto-updater is already running");
        return;
    }

    info!(
        "Initializing auto-updater (interval: {}h)",
        UPDATE_CHECK_INTERVAL.as_secs() / 3600
    );

    crate::utils::spawn(async move {
        // Run initial check immediately on startup
        let mut checked = run_update_checks(&app).await;

        while app
            .state::<crate::utils::types::state::RcloneState>()
            .updater_running
            .load(Ordering::Acquire)
        {
            // A locked vault must not postpone the first check by a full interval.
            sleep(if checked {
                UPDATE_CHECK_INTERVAL
            } else {
                UNAVAILABLE_RETRY_INTERVAL
            })
            .await;
            checked = run_update_checks(&app).await;
        }

        info!("Auto-updater stopped.");
    });
}

/// Signals the background task to exit on its next iteration.
pub fn stop_auto_updater(app: &AppHandle) {
    let state = app.state::<crate::utils::types::state::RcloneState>();
    state.updater_running.store(false, Ordering::Release);
}

/// Returns `false` when settings were unavailable and nothing was checked.
async fn run_update_checks(app: &AppHandle) -> bool {
    info!("Running scheduled update checks...");

    let config = match app.state::<AppSettingsManager>().get_all() {
        Ok(config) => config,
        Err(error) => {
            debug!("Skipping update checks while settings are unavailable: {error}");
            return false;
        }
    };

    #[cfg(feature = "updater")]
    crate::services::updates::report_failed_updates(app);

    if config.runtime.app_auto_check_updates {
        let channel = config.runtime.app_update_channel.clone();
        info!("Checking for app updates (channel: {channel})...");
        if let Err(e) = check_app_update(app, &channel).await {
            warn!("App update check failed: {e}");
        }
    }

    #[cfg(not(feature = "librclone"))]
    if config.runtime.rclone_auto_check_updates {
        let channel = config.runtime.rclone_update_channel.clone();
        info!("Checking for rclone updates (channel: {channel})...");
        if let Err(e) =
            crate::rclone::binaries::updater::check_rclone_update(app.clone(), Some(channel)).await
        {
            warn!("Rclone update check failed: {e}");
        }
    }
    true
}

async fn check_app_update(app: &AppHandle, channel: &str) -> Result<(), String> {
    crate::services::updates::fetch_update(app.clone(), channel.to_string())
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn locked_settings_do_not_trigger_update_requests_with_default_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let (app, _) = crate::services::settings::access::tests::app(directory.path());
        app.state::<super::AppSettingsManager>().lock().unwrap();
        // No updater state or remote transport is needed while settings are locked.
        assert!(!super::run_update_checks(&app).await);
    }
}
