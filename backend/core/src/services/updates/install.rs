//! Download and installation state machine; platform installers implement AppUpdate.
use crate::context::AppHandle;
use crate::services::updates::emit_state_changed;
use crate::utils::app::notification::NotificationEvent;
use crate::utils::app::notification::UpdateStage;
use crate::utils::app::notification::notify;
use crate::utils::types::events::APP_EVENT;
use crate::utils::types::updater::AppUpdaterState;
use crate::utils::types::updater::DownloadStatus;
use crate::utils::types::updater::Result;
use crate::utils::types::updater::UpdateState;
use crate::utils::types::updater::UpdaterError as Error;
use log::{error, info, warn};
fn emit_progress(status: DownloadStatus) {
    crate::services::bridge::emit(
        APP_EVENT,
        serde_json::json!({ "status": "download_progress", "data": status }),
    );
}

pub async fn install_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();
    let _operation = updater_state.operation.lock().await;

    let update = {
        let mut data = updater_state.data.lock();
        if matches!(
            data.state,
            UpdateState::Downloading | UpdateState::ReadyToRestart
        ) {
            return Ok(());
        }
        let update = data.pending_action.clone().ok_or(Error::NoPendingUpdate)?;
        data.state = UpdateState::Downloading;
        data.downloaded_bytes = 0;
        data.total_bytes = 0;
        data.failure_message = None;
        update
    };
    emit_state_changed();

    info!("Downloading app update from: {}", update.download_url());
    notify(
        &app,
        NotificationEvent::AppUpdate(UpdateStage::Started {
            version: update.version().to_string(),
        }),
    );

    let app_clone = app.clone();

    let handle = crate::utils::spawn(async move {
        let progress_app = app_clone.clone();
        let mut last_emit = std::time::Instant::now();

        let res = update
            .download(Box::new(move |chunk_length, content_length| {
                let st = progress_app.state::<AppUpdaterState>();
                let now = std::time::Instant::now();
                let progress = {
                    let mut data = st.data.lock();
                    data.downloaded_bytes += chunk_length as u64;
                    if let Some(t) = content_length {
                        data.total_bytes = t;
                    }
                    if now.duration_since(last_emit).as_millis() >= 200 {
                        data.download_status()
                    } else {
                        None
                    }
                };

                if let Some(progress) = progress {
                    emit_progress(progress);
                    last_emit = now;
                }
            }))
            .await;

        let st = app_clone.state::<AppUpdaterState>();
        match res {
            Ok(downloaded_payload) => {
                let progress = {
                    let mut data = st.data.lock();
                    data.state = UpdateState::ReadyToRestart;
                    data.downloaded_payload = Some(downloaded_payload);
                    data.download_status()
                };
                notify(
                    &app_clone,
                    NotificationEvent::AppUpdate(UpdateStage::Downloaded {
                        version: update.version().to_string(),
                    }),
                );
                if let Some(progress) = progress {
                    emit_progress(progress);
                }
            }
            Err(e) => {
                warn!("App update download failed: {e}");
                let failure =
                    crate::localized_error!("backendErrors.updater.updateFailed", "error" => e);
                let progress = {
                    let mut data = st.data.lock();
                    data.state = UpdateState::Available;
                    data.failure_message = Some(failure);
                    data.download_status()
                };
                notify(
                    &app_clone,
                    NotificationEvent::AppUpdate(UpdateStage::Failed {
                        error: e.to_string(),
                    }),
                );
                if let Some(progress) = progress {
                    emit_progress(progress);
                }
            }
        }
        emit_state_changed();
    });

    updater_state.data.lock().download_handle = Some(handle);
    Ok(())
}

pub async fn cancel_app_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();
    updater_state.cancel_download().await;

    emit_state_changed();
    Ok(())
}

pub async fn apply_app_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();

    let (update, downloaded_payload) = {
        let mut data = updater_state.data.lock();
        data.take_staged_update().ok_or(Error::NoPendingUpdate)?
    };

    info!("Applying app update in background blocking task...");

    crate::utils::spawn_blocking(move || {
        #[cfg(not(target_os = "windows"))]
        let version = update.version().to_string();

        if let Err(e) = update.install(downloaded_payload) {
            log::error!("Failed to install update: {e}");
            let state = app.state::<AppUpdaterState>();
            let mut data = state.data.lock();
            data.state = UpdateState::Available;
            data.pending_action = Some(update);
            drop(data);
            emit_state_changed();
            return;
        }

        #[cfg(not(target_os = "windows"))]
        crate::utils::block_on(async move {
            notify(
                &app,
                NotificationEvent::AppUpdate(UpdateStage::Installed { version }),
            );
            app.state::<AppUpdaterState>().data.lock().state = UpdateState::Idle;
            if let Err(e) = crate::utils::app::platform::relaunch_app(app).await {
                log::error!("Failed to relaunch app: {e}");
            }
        });
    });

    Ok(())
}

/// Apply a staged native payload during the shared shutdown sequence.
pub(crate) fn install_staged_update(app_handle: &AppHandle) {
    // App self-update (requires the 'updater' Tauri feature).
    if let Some(state) = app_handle.try_state::<crate::utils::types::updater::AppUpdaterState>() {
        let staged = {
            let mut d = state.data.lock();
            if let Some(update) = d.take_staged_update() {
                d.state = crate::utils::types::updater::UpdateState::Idle;
                Some(update)
            } else {
                None
            }
        };

        if let Some((update, payload)) = staged {
            info!("Applying staged app update...");
            if let Err(e) = update.install(payload) {
                error!("Failed to apply app update: {e}");
            }
        }
    }
}
