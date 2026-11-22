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

/// `general.keep_alive` and `general.start_on_boot` as last read with the vault open. A vault
/// that locks later stops nothing (automations run from the snapshots taken at startup), so
/// the service keeps getting the counts with these values.
static LAST_SETTINGS: parking_lot::Mutex<Option<(bool, bool)>> = parking_lot::Mutex::new(None);

/// The vault state last sent to the service, so a sync sends it only when it changes.
static SENT_VAULT_LOCKED: parking_lot::Mutex<Option<bool>> = parking_lot::Mutex::new(None);

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

    let read = app.try_state::<AppSettingsManager>().and_then(|settings| {
        match (
            settings.get::<bool>("general.keep_alive"),
            settings.get::<bool>("general.start_on_boot"),
        ) {
            (Ok(keep_alive), Ok(start_on_boot)) => Some((keep_alive, start_on_boot)),
            _ => None,
        }
    });
    let settings = match read {
        Some(values) => {
            *LAST_SETTINGS.lock() = Some(values);
            Some(values)
        }
        None => *LAST_SETTINGS.lock(),
    };
    // Never read in this process: the vault was locked from the start, initialization stopped
    // before anything could run, and the notification asks for the unlock. The unlock starts
    // initialization again, which syncs once more.
    let waiting_for_unlock =
        settings.is_none() && crate::services::settings::access::is_locked(app);
    if SENT_VAULT_LOCKED.lock().replace(waiting_for_unlock) != Some(waiting_for_unlock) {
        saf_bridge::set_vault_locked(waiting_for_unlock);
    }
    let Some((keep_alive, start_on_boot)) = settings else {
        return;
    };

    let manager = app.state::<BackendManager>();
    let jobs = manager
        .job_cache_for(LOCAL_BACKEND_NAME)
        .active_job_count()
        .await;
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
