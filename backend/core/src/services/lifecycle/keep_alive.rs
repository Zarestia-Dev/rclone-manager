//! Keeps the Android foreground service and its notification in step with what is running.
//! It lives in the backend so it works after a boot start, before any UI exists.

use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, saf_bridge};
use crate::services::settings::AppSettingsManager;
use crate::utils::constants::LOCAL_BACKEND_NAME;
use crate::utils::i18n::{localized_operation_counts, localized_progress};
use crate::utils::types::state::RcloneState;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

/// Job events arrive in bursts; one update covers all of them.
const DEBOUNCE: Duration = Duration::from_millis(500);
/// The shortest time between two updates. Every running job reports its stats twice a second;
/// the notification follows them no faster than this, which also spares the battery.
const MIN_INTERVAL: Duration = Duration::from_secs(2);

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
                    // A request made meanwhile is kept and handled once this wait is over.
                    tokio::time::sleep(MIN_INTERVAL - DEBOUNCE).await;
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
    let mut progress = manager
        .job_cache_for(LOCAL_BACKEND_NAME)
        .running_progress()
        .await;
    // An upload to an rclone on another computer, or a download from it, streams through this
    // device, so it keeps the device awake and shows its progress like a job of the local engine.
    for backend in manager.list_all().await {
        if backend.name != LOCAL_BACKEND_NAME {
            progress.add(
                manager
                    .job_cache_for(&backend.name)
                    .own_job_progress()
                    .await,
            );
        }
    }
    let remotes = manager.remote_cache_for(LOCAL_BACKEND_NAME);
    let (mounts, serves) = tokio::join!(remotes.get_mounted_remotes(), remotes.get_serves());

    // Empty when nothing runs, so the service shows its own idle text.
    let text = localized_operation_counts(mounts.len(), progress.jobs, serves.len()).join(" • ");
    let progress_text = if progress.jobs > 0 {
        localized_progress(&progress)
    } else {
        String::new()
    };
    saf_bridge::set_start_on_boot(start_on_boot);
    saf_bridge::sync_keep_alive(
        keep_alive,
        progress.jobs,
        mounts.len(),
        serves.len(),
        &text,
        &progress_text,
        progress.percent().map_or(-1, i32::from),
    );
}
