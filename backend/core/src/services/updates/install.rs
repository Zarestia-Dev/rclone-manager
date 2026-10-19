//! Download and installation state machine; platform installers implement AppUpdate.
use crate::context::AppHandle;
use crate::services::updates::emit_state_changed;
use crate::utils::app::notification::NotificationEvent;
use crate::utils::app::notification::UpdateStage;
use crate::utils::app::notification::notify;
use crate::utils::types::events::APP_EVENT;
use crate::utils::types::updater::AppUpdaterState;
use crate::utils::types::updater::DownloadStatus;
use crate::utils::types::updater::InstallOutcome;
use crate::utils::types::updater::Result;
use crate::utils::types::updater::UpdateState;
use crate::utils::types::updater::UpdaterError as Error;
use log::{info, warn};
fn emit_progress(status: DownloadStatus) {
    crate::services::bridge::emit(
        APP_EVENT,
        serde_json::json!({ "status": "download_progress", "data": status }),
    );
}

fn failure_message(error: &str) -> String {
    let structured = serde_json::from_str::<serde_json::Value>(error)
        .ok()
        .and_then(|value| {
            value
                .get("key")
                .and_then(|key| key.as_str())
                .map(str::to_owned)
        });
    if structured
        .as_deref()
        .is_some_and(|key| key.starts_with("backendErrors."))
        || error.starts_with("backendErrors.")
    {
        error.to_string()
    } else {
        crate::localized_error!("backendErrors.updater.updateFailed", "error" => error)
    }
}

pub async fn install_update(app: AppHandle) -> Result<()> {
    ensure_install_allowed(&app).await?;
    let updater_state = app.state::<AppUpdaterState>();
    let _operation = updater_state.operation.lock().await;

    let update = {
        let mut data = updater_state.data.lock();
        if matches!(
            data.state,
            UpdateState::Downloading | UpdateState::ReadyToRestart | UpdateState::Installing
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
                info!(
                    "App update ready to install: version={}, payload_bytes={}",
                    update.version(),
                    downloaded_payload.len()
                );
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
                let failure = failure_message(&e);
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
    info!("Cancelling application update");
    let updater_state = app.state::<AppUpdaterState>();
    updater_state.cancel_update().await;

    emit_state_changed();
    Ok(())
}

async fn ensure_install_allowed(app: &AppHandle) -> Result<()> {
    let policy = super::policy::get_update_policy(app.clone()).await;
    if !policy.can_install {
        return Err(Error::Backend(policy.reason.unwrap_or_else(|| {
            crate::localized_error!("backendErrors.updater.unsupportedInstallation")
        })));
    }
    Ok(())
}

pub async fn apply_app_update(app: AppHandle) -> Result<()> {
    ensure_install_allowed(&app).await?;
    let state = app.state::<AppUpdaterState>();
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| Error::NoPendingUpdate)?;
    let (update, payload) = {
        let mut data = state.data.lock();
        let staged = data.take_staged_update().ok_or(Error::NoPendingUpdate)?;
        data.state = UpdateState::Installing;
        data.failure_message = None;
        staged
    };
    emit_state_changed();
    info!(
        "Applying app update: version={}, payload_bytes={}",
        update.version(),
        payload.len()
    );
    let result = crate::utils::spawn_blocking(move || {
        let result = update.install(&payload);
        (update, payload, result)
    })
    .await;
    let (update, payload, result) = match result {
        Ok(result) => result,
        Err(error) => {
            let failure = failure_message(&error.to_string());
            let mut data = state.data.lock();
            data.state = UpdateState::Available;
            data.failure_message = Some(failure.clone());
            drop(data);
            emit_state_changed();
            return Err(Error::Backend(failure));
        }
    };
    match result {
        Err(error) => {
            warn!("App update installation failed: {error}");
            let failure = failure_message(&error);
            let mut data = state.data.lock();
            data.state = UpdateState::ReadyToRestart;
            data.pending_action = Some(update);
            data.downloaded_payload = Some(payload);
            data.failure_message = Some(failure.clone());
            drop(data);
            emit_state_changed();
            Err(Error::Backend(failure))
        }
        Ok(InstallOutcome::AwaitingUser) => {
            let mut data = state.data.lock();
            data.state = UpdateState::ReadyToRestart;
            data.pending_action = Some(update);
            data.downloaded_payload = Some(payload);
            drop(data);
            emit_state_changed();
            Ok(())
        }
        Ok(outcome) => {
            // Let HTTP/IPC deliver the apply response before the process exits.
            crate::utils::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                match outcome {
                    #[cfg(unix)]
                    InstallOutcome::RestartBinary {
                        executable,
                        previous,
                        arguments,
                        working_directory,
                    } => {
                        shutdown_for_update(app.clone()).await;
                        let result = app.host().restart_updated_binary(
                            &executable,
                            &previous,
                            &arguments,
                            &working_directory,
                        );
                        if let Err(error) = result {
                            let state = app.state::<AppUpdaterState>();
                            let mut data = state.data.lock();
                            data.state = UpdateState::Available;
                            data.failure_message = Some(
                                crate::localized_error!("backendErrors.updater.relaunchFailed", "error" => error),
                            );
                            drop(data);
                            emit_state_changed();
                        }
                    }
                    InstallOutcome::Exit => {
                        shutdown_for_update(app.clone()).await;
                        app.exit(0);
                    }
                    InstallOutcome::Restart => {
                        if let Err(error) =
                            crate::utils::app::platform::relaunch_app(app.clone()).await
                        {
                            log::error!("Failed to restart after application update: {error}");
                            let state = app.state::<AppUpdaterState>();
                            let mut data = state.data.lock();
                            data.state = UpdateState::Available;
                            data.failure_message = Some(
                                crate::localized_error!("backendErrors.updater.relaunchFailed", "error" => error),
                            );
                            drop(data);
                            emit_state_changed();
                        }
                    }
                    InstallOutcome::AwaitingUser => unreachable!(),
                }
            });
            Ok(())
        }
    }
}

async fn shutdown_for_update(app: AppHandle) {
    if tokio::time::timeout(
        std::time::Duration::from_secs(20),
        crate::services::lifecycle::shutdown::handle_shutdown(app),
    )
    .await
    .is_err()
    {
        log::error!("Update cleanup exceeded shutdown deadline");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::Host;
    use crate::utils::types::updater::{AppUpdate, DownloadProgress, UpdateMetadata};
    use std::sync::Arc;

    #[test]
    fn localized_installer_errors_are_not_wrapped_as_untranslated_json_parameters() {
        let error = crate::localized_error!("backendErrors.updater.androidInstallPermission");
        assert_eq!(failure_message(&error), error);
        assert_eq!(
            failure_message("backendErrors.updater.notWritable"),
            "backendErrors.updater.notWritable"
        );
        let parsed: serde_json::Value =
            serde_json::from_str(&failure_message("Disk full")).unwrap();
        assert_eq!(parsed["key"], "backendErrors.updater.updateFailed");
        assert_eq!(parsed["params"]["error"], "Disk full");
    }

    struct BinaryHost;
    #[async_trait::async_trait]
    impl Host for BinaryHost {
        fn update_method(&self) -> super::super::policy::UpdateMethod {
            super::super::policy::UpdateMethod::Binary
        }
        fn resolve_paths(
            &self,
            _app: &AppHandle,
        ) -> std::result::Result<crate::services::paths::AppPaths, String> {
            Err("Not needed".into())
        }
        fn restart(&self, _app: &AppHandle) -> std::result::Result<(), String> {
            panic!("Failed installs must not restart")
        }
    }

    struct FailingUpdate(url::Url);
    #[async_trait::async_trait]
    impl AppUpdate for FailingUpdate {
        fn version(&self) -> &str {
            "99.0.0"
        }
        fn download_url(&self) -> &url::Url {
            &self.0
        }
        async fn download(&self, _: DownloadProgress) -> std::result::Result<Vec<u8>, String> {
            panic!("A retry must reuse verified bytes")
        }
        fn install(&self, bytes: &[u8]) -> std::result::Result<InstallOutcome, String> {
            assert_eq!(bytes, b"verified");
            Err("Authorization declined".into())
        }
    }

    #[tokio::test]
    async fn failed_apply_preserves_payload_and_reports_failure_without_restarting() {
        let app = AppHandle::new(Arc::new(BinaryHost), Default::default());
        let state = AppUpdaterState::default();
        {
            let mut data = state.data.lock();
            data.state = UpdateState::ReadyToRestart;
            data.last_metadata = Some(UpdateMetadata {
                version: "99.0.0".into(),
                ..Default::default()
            });
            data.pending_action = Some(Arc::new(FailingUpdate(
                "https://example.invalid/update".parse().unwrap(),
            )));
            data.downloaded_payload = Some(b"verified".to_vec());
        }
        app.manage(state);
        assert!(apply_app_update(app.clone()).await.is_err());
        let state = app.state::<AppUpdaterState>();
        let data = state.data.lock();
        assert_eq!(data.state, UpdateState::ReadyToRestart);
        assert_eq!(
            data.downloaded_payload.as_deref(),
            Some(b"verified".as_slice())
        );
        assert!(data.pending_action.is_some());
        assert!(matches!(
            data.download_status().unwrap().state,
            crate::utils::types::updater::DownloadState::Failed(_)
        ));
    }

    #[tokio::test]
    async fn unsupported_hosts_cannot_apply_even_a_staged_update() {
        let app = AppHandle::default();
        app.manage(AppUpdaterState::default());
        assert!(apply_app_update(app.clone()).await.is_err());
        assert!(install_update(app).await.is_err());
    }
}
