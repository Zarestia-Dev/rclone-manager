#[cfg(desktop)]
pub mod app_updates {
    use crate::core::lifecycle::shutdown::shutdown_app;
    use crate::utils::app::platform::relaunch_app;
    use crate::utils::types::updater::{
        AppUpdaterState, DownloadStatus, Result, UpdateInfo, UpdateMetadata, UpdateStatus,
        UpdaterError as Error,
    };
    use crate::utils::{
        app::notification::{NotificationEvent, UpdateStage, notify},
        github_client,
        types::core::RcloneState,
    };
    use log::{debug, info, warn};
    use std::sync::atomic::Ordering;
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;

    #[tauri::command]
    pub async fn fetch_update(app: AppHandle, channel: String) -> Result<Option<UpdateInfo>> {
        let updater_state = app.state::<AppUpdaterState>();

        if updater_state.is_restart_required.load(Ordering::Acquire) {
            info!("App restart is already required for a pending update");
            return Ok(Some(UpdateInfo {
                metadata: UpdateMetadata {
                    version: String::new(),
                    current_version: app.package_info().version.to_string(),
                    update_available: true,
                    release_tag: None,
                    ..Default::default()
                },
                status: UpdateStatus::ReadyToRestart,
            }));
        }

        if updater_state.is_updating.load(Ordering::Acquire) {
            info!("Update download is already in progress");
            return Ok(Some(UpdateInfo {
                metadata: UpdateMetadata {
                    version: String::new(),
                    current_version: app.package_info().version.to_string(),
                    update_available: true,
                    release_tag: None,
                    ..Default::default()
                },
                status: UpdateStatus::Downloading,
            }));
        }

        updater_state.downloaded_bytes.store(0, Ordering::Relaxed);
        updater_state.total_bytes.store(0, Ordering::Relaxed);
        updater_state.with_data(|d| {
            d.failure_message = None;
            d.last_metadata = None;
        });

        info!("Checking for app updates on channel: {channel}");

        const OWNER: &str = "Zarestia-Dev";
        const REPO: &str = "rclone-manager";

        let releases = github_client::get_releases(OWNER, REPO).await?;
        let Some(release) = releases
            .into_iter()
            .filter(|r| !r.draft)
            .find(|r| is_release_for_channel(r, &channel))
        else {
            info!("No suitable release found for channel: {channel}");
            return Ok(None);
        };

        let json_asset = release.assets.iter().find(|a| {
            a.name.ends_with(".json")
                && (a.name.contains("latest")
                    || a.name.contains("app")
                    || a.name.contains("update"))
        });

        let json_url = match json_asset {
            Some(asset) => asset.browser_download_url.clone(),
            None => format!(
                "https://github.com/{OWNER}/{REPO}/releases/download/{}/latest.json",
                release.tag_name
            ),
        };

        info!("Using update manifest: {json_url}");

        let app_exit = app.clone();
        let (update, update_metadata) = match app
            .updater_builder()
            .endpoints(vec![json_url.parse()?])?
            .version_comparator(|curr, upd| upd.version != curr)
            .on_before_exit(move || {
                let app = app_exit.clone();
                warn!("Shutting down for update installation...");
                tauri::async_runtime::spawn(async move {
                    app.state::<RcloneState>().set_shutting_down();
                    let _ = shutdown_app(app).await;
                });
            })
            .build()?
            .check()
            .await?
        {
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
                    ..Default::default()
                };

                (Some(u), Some(metadata))
            }
            None => (None, None),
        };

        let update_info = update_metadata.as_ref().map(|metadata| UpdateInfo {
            metadata: metadata.clone(),
            status: UpdateStatus::Available,
        });

        if let Some(ref info) = update_info {
            let _ = app.emit(
                crate::utils::types::events::APP_EVENT,
                serde_json::json!({
                    "status": "update_found",
                    "data": info
                }),
            );

            notify(
                &app,
                NotificationEvent::AppUpdate(UpdateStage::Available {
                    version: info.metadata.version.clone(),
                }),
            );
        }

        updater_state.with_data(|d| {
            d.last_metadata = update_metadata;
            d.pending_action = update;
        });

        Ok(update_info)
    }

    /// Normalizes the download URL to use the specific release tag if the auto-generated
    /// path from the manifest is generic (e.g. contains /download/v1.2.3/ instead of /download/beta-1/).
    fn adjust_download_url(update: &mut tauri_plugin_updater::Update, tag: &str) {
        let version_seg = format!("/download/v{}/", update.version);
        let tag_seg = format!("/download/{tag}/");
        let url_str = update.download_url.to_string();

        if url_str.contains(&version_seg) && !url_str.contains(&tag_seg) {
            let new_url = url_str.replace(&version_seg, &tag_seg);
            if let Ok(parsed) = url::Url::parse(&new_url) {
                debug!("Adjusted update URL: {} -> {}", update.download_url, parsed);
                update.download_url = parsed;
            }
        }
    }

    #[tauri::command]
    pub async fn get_app_update_info(app: AppHandle) -> Result<Option<UpdateInfo>> {
        let updater_state = app.state::<AppUpdaterState>();

        if updater_state.is_restart_required.load(Ordering::Acquire) {
            return Ok(Some(UpdateInfo {
                metadata: UpdateMetadata {
                    version: String::new(),
                    current_version: app.package_info().version.to_string(),
                    update_available: true,
                    release_tag: None,
                    ..Default::default()
                },
                status: UpdateStatus::ReadyToRestart,
            }));
        }

        let metadata = updater_state.with_data(|d| d.last_metadata.clone());
        let is_updating = updater_state.is_updating.load(Ordering::Acquire);

        Ok(metadata.map(|metadata| {
            let status = if is_updating {
                UpdateStatus::Downloading
            } else if metadata.update_available {
                UpdateStatus::Available
            } else {
                UpdateStatus::Idle
            };

            UpdateInfo { metadata, status }
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

        let update = updater_state
            .with_data(|d| d.pending_action.take())
            .ok_or(Error::NoPendingUpdate)?;

        // Reset progress and set updating flag
        updater_state.downloaded_bytes.store(0, Ordering::Relaxed);
        updater_state.total_bytes.store(0, Ordering::Relaxed);
        updater_state.is_updating.store(true, Ordering::Release);
        updater_state.with_data(|d| d.failure_message = None);

        info!("Downloading app update from: {}", update.download_url);

        notify(
            &app,
            NotificationEvent::AppUpdate(UpdateStage::Started {
                version: update.version.clone(),
            }),
        );

        let download_app = app.clone();
        let res = update
            .download(
                {
                    let app = download_app.clone();
                    let mut last_emit = std::time::Instant::now();
                    move |chunk_length, content_length| {
                        let st = app.state::<AppUpdaterState>();
                        let downloaded = st
                            .downloaded_bytes
                            .fetch_add(chunk_length as u64, Ordering::Relaxed)
                            + chunk_length as u64;
                        if let Some(total) = content_length {
                            st.total_bytes.store(total, Ordering::Relaxed);
                        }

                        let total = st.total_bytes.load(Ordering::Relaxed);
                        let percentage = if total > 0 {
                            (downloaded as f64 / total as f64) * 100.0
                        } else {
                            0.0
                        };

                        let now = std::time::Instant::now();
                        if now.duration_since(last_emit).as_millis() >= 200 {
                            let _ = app.emit(
                                crate::utils::types::events::APP_EVENT,
                                serde_json::json!({
                                    "status": "download_progress",
                                    "data": DownloadStatus {
                                        downloaded_bytes: downloaded,
                                        total_bytes: total,
                                        percentage,
                                        is_complete: false,
                                        is_failed: false,
                                        failure_message: None,
                                    }
                                }),
                            );
                            last_emit = now;
                        }
                    }
                },
                || {
                    info!("App update download finished successfully");
                },
            )
            .await;

        match res {
            Ok(signature) => {
                updater_state.is_updating.store(false, Ordering::Release);
                updater_state
                    .is_restart_required
                    .store(true, Ordering::Release);
                updater_state.with_data(|d| {
                    d.signature = Some(signature);
                    d.pending_action = Some(update.clone());
                });

                notify(
                    &app,
                    NotificationEvent::AppUpdate(UpdateStage::Downloaded {
                        version: update.version.clone(),
                    }),
                );

                // Emit final progress
                let st = app.state::<AppUpdaterState>();
                let _ = app.emit(
                    crate::utils::types::events::APP_EVENT,
                    serde_json::json!({
                        "status": "download_progress",
                        "data": DownloadStatus {
                            downloaded_bytes: st.downloaded_bytes.load(Ordering::Relaxed),
                            total_bytes: st.total_bytes.load(Ordering::Relaxed),
                            percentage: 100.0,
                            is_complete: true,
                            is_failed: false,
                            failure_message: None,
                        }
                    }),
                );
                Ok(())
            }
            Err(e) => {
                warn!("App update download failed: {e}");
                updater_state.is_updating.store(false, Ordering::Release);
                updater_state.with_data(|d| {
                    d.failure_message = Some(e.to_string());
                    d.pending_action = Some(update.clone());
                });

                notify(
                    &app,
                    NotificationEvent::AppUpdate(UpdateStage::Failed {
                        error: e.to_string(),
                    }),
                );

                let st = app.state::<AppUpdaterState>();
                let _ = app.emit(
                    crate::utils::types::events::APP_EVENT,
                    serde_json::json!({
                        "status": "download_progress",
                        "data": DownloadStatus {
                            downloaded_bytes: st.downloaded_bytes.load(Ordering::Relaxed),
                            total_bytes: st.total_bytes.load(Ordering::Relaxed),
                            percentage: 0.0,
                            is_complete: false,
                            is_failed: true,
                            failure_message: Some(e.to_string()),
                        }
                    }),
                );

                Err(Error::Tauri(e))
            }
        }
    }

    #[tauri::command]
    pub async fn apply_app_update(app: AppHandle) -> Result<()> {
        let updater_state = app.state::<AppUpdaterState>();

        let (update, signature) = updater_state
            .with_data(|d| match (d.pending_action.take(), d.signature.take()) {
                (Some(u), Some(s)) => Some((u, s)),
                _ => None,
            })
            .ok_or(Error::NoPendingUpdate)?;

        info!("Applying app update and relaunching...");
        updater_state.is_updating.store(true, Ordering::Release);

        if let Err(e) = update.install(signature) {
            updater_state.is_updating.store(false, Ordering::Release);
            updater_state
                .is_restart_required
                .store(false, Ordering::Release);
            return Err(Error::Tauri(e));
        }

        notify(
            &app,
            NotificationEvent::AppUpdate(UpdateStage::Installed {
                version: update.version.clone(),
            }),
        );

        updater_state.is_updating.store(false, Ordering::Release);
        relaunch_app(app).await.map_err(Error::Relaunch)?;
        Ok(())
    }
}
