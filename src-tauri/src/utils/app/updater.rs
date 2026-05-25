#[cfg(desktop)]
pub mod app_updates {
    use crate::core::lifecycle::shutdown::handle_shutdown;
    use crate::utils::app::platform::relaunch_app;
    use crate::utils::types::updater::{
        AppUpdaterState, DownloadState, DownloadStatus, Result, UpdateInfo, UpdateMetadata,
        UpdateState, UpdaterError as Error,
    };
    use crate::utils::{
        app::notification::{NotificationEvent, UpdateStage, notify},
        github_client,
        types::state::RcloneState,
    };
    use log::{debug, info, warn};
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;

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
                // Channel mismatch or no metadata -> reset state
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
                        release_tag: None,
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

        const OWNER: &str = "Zarestia-Dev";
        const REPO: &str = "rclone-manager";

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
                tauri::async_runtime::block_on(async move {
                    app.state::<RcloneState>().set_shutting_down();
                    handle_shutdown(app).await;
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
                    channel: Some(channel.clone()),
                };

                (Some(u), Some(metadata))
            }
            None => (None, None),
        };

        let update_info = update_metadata.as_ref().map(|metadata| UpdateInfo {
            metadata: metadata.clone(),
            status: UpdateState::Available,
        });

        if let Some(ref info) = update_info {
            let _ = app.emit(
                crate::utils::types::events::APP_EVENT,
                serde_json::json!({
                    "status": "update_found",
                    "data": info
                }),
            );

            let is_skipped = app
                .try_state::<crate::core::settings::AppSettingsManager>()
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
        let data = updater_state.data.lock();

        Ok(data.last_metadata.as_ref().map(|metadata| {
            let status = if data.state == UpdateState::Downloading {
                UpdateState::Downloading
            } else if data.state == UpdateState::ReadyToRestart {
                UpdateState::ReadyToRestart
            } else if metadata.update_available {
                UpdateState::Available
            } else {
                UpdateState::Idle
            };

            UpdateInfo {
                metadata: metadata.clone(),
                status,
            }
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

        // Reset progress and set updating flag
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
            let res = update
                .download(
                    {
                        let app = app_clone.clone();
                        let mut last_emit = std::time::Instant::now();
                        move |chunk_length, content_length| {
                            let st = app.state::<AppUpdaterState>();
                            let (downloaded, total) = {
                                let mut data = st.data.lock();
                                data.downloaded_bytes += chunk_length as u64;
                                if let Some(total) = content_length {
                                    data.total_bytes = total;
                                }
                                (data.downloaded_bytes, data.total_bytes)
                            };

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
                                            state: DownloadState::InProgress,
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

                    let _ = app_clone.emit(
                        crate::utils::types::events::APP_EVENT,
                        serde_json::json!({
                            "status": "download_progress",
                            "data": DownloadStatus {
                                downloaded_bytes: downloaded,
                                total_bytes: total,
                                percentage: 100.0,
                                state: DownloadState::Complete,
                            }
                        }),
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

                    let _ = app_clone.emit(
                        crate::utils::types::events::APP_EVENT,
                        serde_json::json!({
                            "status": "download_progress",
                            "data": DownloadStatus {
                                downloaded_bytes: downloaded,
                                total_bytes: total,
                                percentage: 0.0,
                                state: DownloadState::Failed(e.to_string()),
                            }
                        }),
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
                (Some(u), Some(s)) => Some((u, s)),
                _ => None,
            }
        }
        .ok_or(Error::NoPendingUpdate)?;

        info!("Applying app update and relaunching...");

        if let Err(e) = update.install(signature) {
            updater_state.data.lock().state = UpdateState::Available;
            return Err(Error::Tauri(e));
        }

        notify(
            &app,
            NotificationEvent::AppUpdate(UpdateStage::Installed {
                version: update.version.clone(),
            }),
        );

        updater_state.data.lock().state = UpdateState::Idle;
        relaunch_app(app).await.map_err(Error::Relaunch)?;
        Ok(())
    }
}
