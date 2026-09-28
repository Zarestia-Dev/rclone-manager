#[cfg(feature = "updater")]
use crate::core::lifecycle::shutdown::handle_shutdown;
use crate::core::{bridge, settings::AppSettingsManager};
use crate::utils::context::{AppHandle, Manager};
use crate::utils::github_client::{OWNER, REPO};
#[cfg(feature = "updater")]
use crate::utils::types::updater::{DownloadStatus, UpdaterError as Error};
use crate::utils::types::{
    events::{APP_EVENT, UPDATER_STATE_CHANGED, UpdaterStateChanged},
    updater::{AppUpdaterState, Result, UpdateInfo, UpdateMetadata, UpdateState},
};
use crate::utils::{
    app::notification::{NotificationEvent, UpdateStage, notify},
    github_client,
};
use log::info;
#[cfg(feature = "updater")]
use log::warn;
#[cfg(feature = "updater")]
use tauri_plugin_updater::UpdaterExt;

#[cfg(feature = "updater")]
fn emit_progress(status: DownloadStatus) {
    crate::core::bridge::emit(
        APP_EVENT,
        serde_json::json!({ "status": "download_progress", "data": status }),
    );
}

fn emit_state_changed() {
    crate::core::bridge::emit(UPDATER_STATE_CHANGED, UpdaterStateChanged::App);
}

pub use crate::utils::version::{clean_app_version, is_version_newer};

#[bridge]
pub async fn fetch_update(app: AppHandle, channel: String) -> Result<Option<UpdateInfo>> {
    let updater_state = app.state::<AppUpdaterState>();
    let result = fetch_update_inner(&app, &channel, &updater_state).await;
    if result.is_err() {
        let mut data = updater_state.data.lock();
        if data.state == UpdateState::Checking {
            data.state = UpdateState::Idle;
        }
    }
    emit_state_changed();
    result
}

async fn fetch_update_inner(
    app: &AppHandle,
    channel: &str,
    updater_state: &AppUpdaterState,
) -> Result<Option<UpdateInfo>> {
    {
        let mut data = updater_state.data.lock();
        if matches!(
            data.state,
            UpdateState::Downloading | UpdateState::ReadyToRestart | UpdateState::Checking
        ) {
            return Ok(data.info());
        }

        data.state = UpdateState::Checking;
        data.downloaded_bytes = 0;
        data.total_bytes = 0;
        data.failure_message = None;
        data.last_metadata = None;
        data.downloaded_payload = None;
        #[cfg(feature = "updater")]
        {
            data.pending_action = None;
        }
    }

    info!("Checking for app updates on channel: {channel}");

    let releases = github_client::get_releases(OWNER, REPO).await?;
    let Some(release) = releases
        .into_iter()
        .filter(|r| !r.draft)
        .find(|r| is_release_for_channel(r, channel))
    else {
        info!("No suitable release found for channel: {channel}");
        updater_state.data.lock().state = UpdateState::Idle;
        return Ok(None);
    };

    let current_version_str = env!("CARGO_PKG_VERSION").to_string();
    let release_version_str = clean_app_version(&release.tag_name);

    let is_newer = is_version_newer(&current_version_str, release_version_str);
    if !is_newer {
        info!("App is up to date (current: {current_version_str}, latest: {release_version_str})");
        updater_state.data.lock().state = UpdateState::Idle;
        return Ok(None);
    }

    info!("Newer version found: {release_version_str} (current: {current_version_str})");

    let update_metadata = UpdateMetadata {
        version: release_version_str.to_string(),
        current_version: current_version_str,
        release_tag: Some(release.tag_name.clone()),
        release_notes: release.body.clone(),
        release_date: release.published_at.clone(),
        release_url: Some(release.html_url.clone()),
        update_available: true,
        channel: Some(channel.to_string()),
    };

    #[cfg(feature = "updater")]
    let (pending_action, update_metadata) = if crate::utils::app::platform::can_auto_install() {
        let mut meta = update_metadata;
        let action = check_native_updater(app, &release, &mut meta).await;
        (action, meta)
    } else {
        (None, update_metadata)
    };

    let update_info = UpdateInfo {
        metadata: update_metadata.clone(),
        status: UpdateState::Available,
        download: None,
    };

    {
        let mut data = updater_state.data.lock();
        data.state = UpdateState::Available;
        data.last_metadata = Some(update_metadata);
        #[cfg(feature = "updater")]
        {
            data.pending_action = pending_action;
        }
    }
    crate::core::bridge::emit(
        APP_EVENT,
        serde_json::json!({ "status": "update_found", "data": &update_info }),
    );

    let is_skipped = app
        .try_state::<AppSettingsManager>()
        .and_then(|m| m.get_all().ok())
        .is_some_and(|c| {
            c.runtime
                .app_skipped_updates
                .contains(&update_info.metadata.version)
        });

    if !is_skipped {
        notify(
            app,
            NotificationEvent::AppUpdate(UpdateStage::Available {
                version: update_info.metadata.version.clone(),
            }),
        );
    }

    Ok(Some(update_info))
}

#[cfg(feature = "updater")]
async fn check_native_updater(
    app: &AppHandle,
    release: &github_client::Release,
    metadata: &mut UpdateMetadata,
) -> Option<tauri_plugin_updater::Update> {
    let json_url = release
        .assets
        .iter()
        .find(|a| {
            a.name.ends_with(".json")
                && (a.name.contains("latest")
                    || a.name.contains("app")
                    || a.name.contains("update"))
        })
        .map(|a| a.browser_download_url.clone())
        .unwrap_or_else(|| {
            format!(
                "https://github.com/{OWNER}/{REPO}/releases/download/{}/latest.json",
                release.tag_name
            )
        });

    info!("Using update manifest: {json_url}");

    let endpoint = json_url.parse().ok()?;
    let app_exit = app.clone();
    let updater_builder = app.updater_builder().endpoints(vec![endpoint]).ok()?;

    let check_result = updater_builder
        .version_comparator(|curr, upd| upd.version != curr)
        .on_before_exit(move || {
            let app = app_exit.clone();
            warn!("Shutting down for update installation...");
            crate::utils::block_on(async move {
                handle_shutdown(app).await;
            });
        })
        .build()
        .ok()?
        .check()
        .await
        .ok()?;

    if let Some(mut u) = check_result {
        adjust_download_url(&mut u, &release.tag_name);
        metadata.version = u.version.clone();
        metadata.current_version = u.current_version.clone();
        Some(u)
    } else {
        None
    }
}

// Rewrites the download URL to use the release tag path instead of the generic
// version path that the manifest may have generated (e.g. /download/beta-1/ vs /download/v1.2.3/).
#[cfg(feature = "updater")]
fn adjust_download_url(update: &mut tauri_plugin_updater::Update, tag: &str) {
    let version_seg = format!("/download/v{}/", update.version);
    let tag_seg = format!("/download/{tag}/");
    let url_str = update.download_url.to_string();

    if url_str.contains(&version_seg)
        && !url_str.contains(&tag_seg)
        && let Ok(parsed) = url_str.replace(&version_seg, &tag_seg).parse()
    {
        log::debug!("Adjusted update URL: {} -> {}", update.download_url, parsed);
        update.download_url = parsed;
    }
}

#[bridge]
pub async fn get_app_update_info(app: AppHandle) -> Result<Option<UpdateInfo>> {
    let state = app.state::<AppUpdaterState>();
    let data = state.data.lock();
    Ok(data.info())
}

fn is_release_for_channel(release: &github_client::Release, channel: &str) -> bool {
    let tag = release.tag_name.to_lowercase();

    #[cfg(feature = "web-server")]
    if !tag.starts_with("headless-") {
        return false;
    }

    #[cfg(not(feature = "web-server"))]
    if tag.starts_with("headless-") {
        return false;
    }

    let is_pre = release.prerelease
        || tag.contains("beta")
        || tag.contains("alpha")
        || tag.contains("rc")
        || tag.contains("dev")
        || tag.contains("preview");

    match channel {
        "stable" => !is_pre,
        "beta" => true,
        _ => !is_pre,
    }
}

#[cfg(feature = "updater")]
#[bridge]
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

    info!("Downloading app update from: {}", update.download_url);
    notify(
        &app,
        NotificationEvent::AppUpdate(UpdateStage::Started {
            version: update.version.clone(),
        }),
    );

    let app_clone = app.clone();

    let handle = crate::utils::spawn(async move {
        let progress_app = app_clone.clone();
        let mut last_emit = std::time::Instant::now();

        let res = update
            .download(
                move |chunk_length, content_length| {
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
                },
                || info!("App update download finished successfully"),
            )
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
                        version: update.version.clone(),
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

#[cfg(feature = "updater")]
#[bridge]
pub async fn cancel_app_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();
    updater_state.cancel_download().await;

    emit_state_changed();
    Ok(())
}

#[cfg(feature = "updater")]
#[bridge]
pub async fn apply_app_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();

    let (update, downloaded_payload) = {
        let mut data = updater_state.data.lock();
        data.take_staged_update().ok_or(Error::NoPendingUpdate)?
    };

    info!("Applying app update in background blocking task...");

    crate::utils::spawn_blocking(move || {
        #[cfg(not(target_os = "windows"))]
        let version = update.version.clone();

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

#[cfg(all(test, not(feature = "native-tauri")))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn checks_preserve_active_downloads_and_staged_updates_across_channels() {
        let app = AppHandle::default();
        let state = AppUpdaterState::default();
        for status in [UpdateState::Downloading, UpdateState::ReadyToRestart] {
            {
                let mut data = state.data.lock();
                data.state = status;
                data.last_metadata = Some(UpdateMetadata {
                    version: "1.2.0".into(),
                    channel: Some("stable".into()),
                    update_available: true,
                    ..Default::default()
                });
                data.downloaded_bytes = 42;
                data.total_bytes = 100;
            }
            let info = fetch_update_inner(&app, "beta", &state)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(info.status, status);
            assert_eq!(info.metadata.channel.as_deref(), Some("stable"));
            assert_eq!(info.metadata.version, "1.2.0");
            assert_eq!(info.download.unwrap().downloaded_bytes, 42);
        }
    }
}
