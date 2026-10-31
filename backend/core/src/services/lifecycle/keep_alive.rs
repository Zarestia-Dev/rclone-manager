//! Keeps the Android foreground service and its notification in step with what is running.
//! It lives in the backend so it works after a boot start, before any UI exists.

use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, saf_bridge};
use crate::services::settings::AppSettingsManager;
use crate::utils::constants::LOCAL_BACKEND_NAME;
use crate::utils::i18n::localized_operation_counts;
use crate::utils::types::state::RcloneState;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

/// Job events arrive in bursts; one update covers all of them.
const DEBOUNCE: Duration = Duration::from_millis(500);

static CHANGED: OnceLock<Arc<Notify>> = OnceLock::new();

/// Asks for the service state to be refreshed soon. A single worker handles the requests, so
/// bursts collapse into one update and updates are never applied out of order.
pub fn request_sync(app: &AppHandle) {
    CHANGED
        .get_or_init(|| {
            let changed = Arc::new(Notify::new());
            let (app, worker) = (app.clone(), changed.clone());
            crate::utils::spawn(async move {
                loop {
                    worker.notified().await;
                    tokio::time::sleep(DEBOUNCE).await;
                    sync(&app).await;
                }
            });
            changed
        })
        .notify_one();
}

async fn sync(app: &AppHandle) {
    if app
        .try_state::<RcloneState>()
        .is_some_and(|state| state.is_shutting_down())
    {
        return;
    }

    // Unreadable while the vault is locked; the unlock starts initialization again.
    let Some(settings) = app.try_state::<AppSettingsManager>() else {
        return;
    };
    let (Ok(keep_alive), Ok(start_on_boot)) = (
        settings.get::<bool>("general.keep_alive"),
        settings.get::<bool>("general.start_on_boot"),
    ) else {
        return;
    };

    let manager = app.state::<BackendManager>();
    let jobs = manager
        .job_cache_for(LOCAL_BACKEND_NAME)
        .get_active_jobs()
        .await
        .len();
    let remotes = manager.remote_cache_for(LOCAL_BACKEND_NAME);
    let (mounts, serves) = tokio::join!(remotes.get_mounted_remotes(), remotes.get_serves());

    // Empty when nothing runs, so the service shows its own idle text.
    let text = localized_operation_counts(mounts.len(), jobs, serves.len()).join(" • ");
    saf_bridge::sync_keep_alive(
        keep_alive,
        start_on_boot,
        jobs,
        mounts.len(),
        serves.len(),
        &text,
    );
}
