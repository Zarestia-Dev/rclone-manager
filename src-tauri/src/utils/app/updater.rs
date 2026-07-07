use crate::core::{lifecycle::shutdown::handle_shutdown, settings::AppSettingsManager};
use crate::utils::github_client::{OWNER, REPO};
use crate::utils::types::{
    events::APP_EVENT,
    state::RcloneState,
    updater::{
        AppUpdaterState, DownloadState, DownloadStatus, Result, UpdateInfo, UpdateMetadata,
        UpdateState, UpdaterError as Error,
    },
};
use crate::utils::{
    app::notification::{NotificationEvent, UpdateStage, notify},
    github_client,
};
use log::{debug, info, warn};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

fn emit_progress(app: &AppHandle, status: DownloadStatus) {
    let _ = app.emit(
        APP_EVENT,
        serde_json::json!({ "status": "download_progress", "data": status }),
    );
}

#[tauri::command]
pub async fn fetch_update(app: AppHandle, channel: String) -> Result<Option<UpdateInfo>> {
    let updater_state = app.state::<AppUpdaterState>();

    {
        let mut data = updater_state.data.lock();
        if data.state == UpdateState::ReadyToRestart {
            if let Some(ref m) = data.last_metadata
                && m.channel.as_deref() == Some(&channel)
            {
                return Ok(Some(UpdateInfo {
                    metadata: m.clone(),
                    status: UpdateState::ReadyToRestart,
                }));
            }
            data.state = UpdateState::Idle;
            data.pending_action = None;
            data.signature = None;
            data.last_metadata = None;
        }

        if data.state == UpdateState::Downloading {
            return Ok(Some(UpdateInfo {
                metadata: UpdateMetadata {
                    version: String::new(),
                    current_version: app.package_info().version.to_string(),
                    update_available: true,
                    channel: Some(channel),
                    ..Default::default()
                },
                status: UpdateState::Downloading,
            }));
        }

        data.state = UpdateState::Checking;
        data.downloaded_bytes = 0;
        data.total_bytes = 0;
        data.failure_message = None;
        data.last_metadata = None;
    }

    info!("Checking for app updates on channel: {channel}");

    let releases = github_client::get_releases(OWNER, REPO).await?;
    let Some(release) = releases
        .into_iter()
        .filter(|r| !r.draft)
        .find(|r| is_release_for_channel(r, &channel))
    else {
        info!("No suitable release found for channel: {channel}");
        updater_state.data.lock().state = UpdateState::Idle;
        return Ok(None);
    };

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

    let app_exit = app.clone();
    let check_result = app
        .updater_builder()
        .endpoints(vec![json_url.parse()?])?
        .version_comparator(|curr, upd| upd.version != curr)
        .on_before_exit(move || {
            let app = app_exit.clone();
            warn!("Shutting down for update installation...");
            tauri::async_runtime::block_on(async move {
                app.state::<RcloneState>().set_shutting_down();
                handle_shutdown(app).await;
            });
        })
        .build()?
        .check()
        .await?;

    let (update, update_metadata) = match check_result {
        Some(mut u) => {
            adjust_download_url(&mut u, &release.tag_name);
            let metadata = UpdateMetadata {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                release_tag: Some(release.tag_name),
                release_notes: release.body,
                release_date: release.published_at,
                release_url: Some(release.html_url),
                update_available: true,
                channel: Some(channel.clone()),
            };
            (Some(u), Some(metadata))
        }
        None => (None, None),
    };

    let update_info = update_metadata.as_ref().map(|m| UpdateInfo {
        metadata: m.clone(),
        status: UpdateState::Available,
    });

    if let Some(ref info) = update_info {
        let _ = app.emit(
            APP_EVENT,
            serde_json::json!({ "status": "update_found", "data": info }),
        );

        let is_skipped = app
            .try_state::<AppSettingsManager>()
            .and_then(|m| m.get_all().ok())
            .is_some_and(|c| {
                c.runtime
                    .app_skipped_updates
                    .contains(&info.metadata.version)
            });

        if !is_skipped {
            notify(
                &app,
                NotificationEvent::AppUpdate(UpdateStage::Available {
                    version: info.metadata.version.clone(),
                }),
            );
        }
    }

    {
        let mut data = updater_state.data.lock();
        data.state = if update_metadata.is_some() {
            UpdateState::Available
        } else {
            UpdateState::Idle
        };
        data.last_metadata = update_metadata;
        data.pending_action = update;
    }

    Ok(update_info)
}

// Rewrites the download URL to use the release tag path instead of the generic
// version path that the manifest may have generated (e.g. /download/beta-1/ vs /download/v1.2.3/).
fn adjust_download_url(update: &mut tauri_plugin_updater::Update, tag: &str) {
    let version_seg = format!("/download/v{}/", update.version);
    let tag_seg = format!("/download/{tag}/");
    let url_str = update.download_url.to_string();

    if url_str.contains(&version_seg)
        && !url_str.contains(&tag_seg)
        && let Ok(parsed) = url_str.replace(&version_seg, &tag_seg).parse()
    {
        debug!("Adjusted update URL: {} -> {}", update.download_url, parsed);
        update.download_url = parsed;
    }
}

#[tauri::command]
pub async fn get_app_update_info(app: AppHandle) -> Result<Option<UpdateInfo>> {
    let state = app.state::<AppUpdaterState>();
    let data = state.data.lock();
    Ok(data.last_metadata.as_ref().map(|metadata| UpdateInfo {
        metadata: metadata.clone(),
        status: match data.state {
            UpdateState::Downloading => UpdateState::Downloading,
            UpdateState::ReadyToRestart => UpdateState::ReadyToRestart,
            _ if metadata.update_available => UpdateState::Available,
            _ => UpdateState::Idle,
        },
    }))
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

    match channel {
        "stable" => !release.prerelease && !tag.contains("beta"),
        "beta" => release.prerelease || tag.contains("beta"),
        _ => !release.prerelease && !tag.contains("beta"),
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();

    let update = {
        let data = updater_state.data.lock();
        if data.state == UpdateState::Downloading {
            return Ok(());
        }
        data.pending_action.clone().ok_or(Error::NoPendingUpdate)?
    };

    {
        let mut data = updater_state.data.lock();
        data.state = UpdateState::Downloading;
        data.downloaded_bytes = 0;
        data.total_bytes = 0;
        data.failure_message = None;
    }

    info!("Downloading app update from: {}", update.download_url);
    notify(
        &app,
        NotificationEvent::AppUpdate(UpdateStage::Started {
            version: update.version.clone(),
        }),
    );

    let app_clone = app.clone();
    let update_clone = update.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let progress_app = app_clone.clone();
        let mut last_emit = std::time::Instant::now();

        let res = update
            .download(
                move |chunk_length, content_length| {
                    let st = progress_app.state::<AppUpdaterState>();
                    let (downloaded, total) = {
                        let mut data = st.data.lock();
                        data.downloaded_bytes += chunk_length as u64;
                        if let Some(t) = content_length {
                            data.total_bytes = t;
                        }
                        (data.downloaded_bytes, data.total_bytes)
                    };

                    let now = std::time::Instant::now();
                    if now.duration_since(last_emit).as_millis() >= 200 {
                        emit_progress(
                            &progress_app,
                            DownloadStatus {
                                downloaded_bytes: downloaded,
                                total_bytes: total,
                                percentage: if total > 0 {
                                    (downloaded as f64 / total as f64) * 100.0
                                } else {
                                    0.0
                                },
                                state: DownloadState::InProgress,
                            },
                        );
                        last_emit = now;
                    }
                },
                || info!("App update download finished successfully"),
            )
            .await;

        let st = app_clone.state::<AppUpdaterState>();
        match res {
            Ok(signature) => {
                let (downloaded, total) = {
                    let mut data = st.data.lock();
                    data.state = UpdateState::ReadyToRestart;
                    data.signature = Some(signature);
                    data.pending_action = Some(update_clone.clone());
                    (data.downloaded_bytes, data.total_bytes)
                };
                notify(
                    &app_clone,
                    NotificationEvent::AppUpdate(UpdateStage::Downloaded {
                        version: update_clone.version.clone(),
                    }),
                );
                emit_progress(
                    &app_clone,
                    DownloadStatus {
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                        percentage: 100.0,
                        state: DownloadState::Complete,
                    },
                );
            }
            Err(e) => {
                warn!("App update download failed: {e}");
                let (downloaded, total) = {
                    let mut data = st.data.lock();
                    data.state = UpdateState::Available;
                    data.failure_message = Some(e.to_string());
                    data.pending_action = Some(update_clone.clone());
                    (data.downloaded_bytes, data.total_bytes)
                };
                notify(
                    &app_clone,
                    NotificationEvent::AppUpdate(UpdateStage::Failed {
                        error: e.to_string(),
                    }),
                );
                emit_progress(
                    &app_clone,
                    DownloadStatus {
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                        percentage: 0.0,
                        state: DownloadState::Failed(e.to_string()),
                    },
                );
            }
        }
    });

    updater_state.data.lock().download_handle = Some(handle);
    Ok(())
}

#[tauri::command]
pub async fn cancel_app_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();
    let mut data = updater_state.data.lock();

    if data.state == UpdateState::Downloading {
        if let Some(handle) = data.download_handle.take() {
            info!("Cancelling app update download");
            handle.abort();
        }
        data.state = if data.last_metadata.is_some() {
            UpdateState::Available
        } else {
            UpdateState::Idle
        };
        data.downloaded_bytes = 0;
        data.total_bytes = 0;
        data.failure_message = Some("Download cancelled by user".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn apply_app_update(app: AppHandle) -> Result<()> {
    let updater_state = app.state::<AppUpdaterState>();

    let (update, signature) = {
        let mut data = updater_state.data.lock();
        match (data.pending_action.take(), data.signature.take()) {
            (Some(u), Some(s)) => (u, s),
            _ => return Err(Error::NoPendingUpdate),
        }
    };

    info!("Applying app update in background thread...");

    // install() triggers on_before_exit which calls block_on — that panics on a Tokio
    // worker thread. A native OS thread has no active runtime, so block_on works fine.
    std::thread::spawn(move || {
        #[cfg(not(target_os = "windows"))]
        let version = update.version.clone();

        if let Err(e) = update.install(signature) {
            log::error!("Failed to install update: {e}");
            let state = app.state::<AppUpdaterState>();
            let mut data = state.data.lock();
            data.state = UpdateState::Available;
            data.pending_action = Some(update);
        }

        #[cfg(not(target_os = "windows"))]
        tauri::async_runtime::block_on(async move {
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
