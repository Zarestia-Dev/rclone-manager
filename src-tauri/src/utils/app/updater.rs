#[cfg(all(desktop, feature = "updater"))]
pub mod app_updates {
    use crate::{
        core::lifecycle::shutdown::handle_shutdown,
        utils::{app::notification::send_notification, github_client, types::core::RcloneState},
    };
    use log::{debug, info, warn};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tauri::{AppHandle, Emitter, Manager, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    #[derive(Debug, thiserror::Error)]
    pub enum Error {
        #[error(transparent)]
        Updater(#[from] tauri_plugin_updater::Error),
        #[error("there is no pending update")]
        NoPendingUpdate,
        #[error("invalid URL: {0}")]
        InvalidUrl(#[from] url::ParseError),
        // Wrap the new GitHub client error
        #[error("GitHub API error: {0}")]
        GitHub(#[from] github_client::Error),
        #[error("mutex error: {0}")]
        Mutex(String),
    }

    impl serde::Serialize for Error {
        fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            let error_msg = match self {
                Error::NoPendingUpdate => {
                    crate::localized_error!("backendErrors.updater.noPending")
                }
                Error::InvalidUrl(e) => {
                    crate::localized_error!("backendErrors.updater.invalidUrl", "error" => e)
                }
                Error::GitHub(e) => {
                    crate::localized_error!("backendErrors.updater.github", "error" => e)
                }
                Error::Mutex(e) => {
                    crate::localized_error!("backendErrors.updater.mutex", "error" => e)
                }
                Error::Updater(e) => {
                    crate::localized_error!("backendErrors.updater.updateFailed", "error" => e)
                }
            };
            serializer.serialize_str(&error_msg)
        }
    }

    type Result<T> = std::result::Result<T, Error>;

    #[derive(Default)]
    pub struct DownloadState {
        pub total_bytes: AtomicU64,
        pub downloaded_bytes: AtomicU64,
        pub is_complete: AtomicBool,
        pub is_failed: AtomicBool,
        pub failure_message: std::sync::Mutex<Option<String>>,
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateMetadata {
        version: String,
        current_version: String,
        release_tag: String,
        release_notes: Option<String>,
        release_date: Option<String>,
        release_url: Option<String>,
        update_in_progress: bool,
        restart_required: bool,
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DownloadStatus {
        pub downloaded_bytes: u64,
        pub total_bytes: u64,
        pub percentage: f64,
        pub is_complete: bool,
        pub is_failed: bool,
        pub failure_message: Option<String>,
    }

    #[tauri::command]
    pub async fn fetch_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
        download_state: State<'_, DownloadState>,
        channel: String,
    ) -> Result<Option<UpdateMetadata>> {
        let state = app.state::<RcloneState>();

        // Check if restart is required first
        let restart_needed = state.is_restart_required.load(Ordering::Relaxed);
        if restart_needed {
            info!("Restart is required");
            return Ok(Some(UpdateMetadata {
                version: String::from("restart"),
                current_version: app.package_info().version.to_string(),
                release_tag: String::from("restart"),
                release_notes: None,
                release_date: None,
                release_url: None,
                update_in_progress: false,
                restart_required: true,
            }));
        }

        // Check if update is already in progress
        let is_updating = state.is_update_in_progress.load(Ordering::Relaxed);
        if is_updating {
            info!("Update is already in progress");
            // Return a minimal metadata indicating update in progress
            // We can reconstruct basic info from download state
            return Ok(Some(UpdateMetadata {
                version: String::from("updating"),
                current_version: app.package_info().version.to_string(),
                release_tag: String::from("updating"),
                release_notes: None,
                release_date: None,
                release_url: None,
                update_in_progress: true,
                restart_required: false,
            }));
        }

        // Reset download state
        download_state.total_bytes.store(0, Ordering::Relaxed);
        download_state.downloaded_bytes.store(0, Ordering::Relaxed);
        download_state.is_complete.store(false, Ordering::Relaxed);

        info!("Checking for updates on channel: {}", channel);

        let owner = "Zarestia-Dev";
        let repo = "rclone-manager";

        let releases: Vec<github_client::Release> =
            github_client::get_releases(owner, repo).await?;

        // Filter and find the appropriate release for the channel
        let suitable_release = releases
            .into_iter()
            .filter(|release| !release.draft)
            .find(|release| is_release_for_channel(release, &channel));

        let release = match suitable_release {
            Some(release) => {
                info!("Found suitable release: {}", release.tag_name);
                release
            }
            None => {
                info!("No suitable release found for channel: {}", channel);
                return Ok(None);
            }
        };

        // Find the JSON update file in release assets
        let json_asset = release.assets.iter().find(|asset| {
            asset.name.ends_with(".json")
                && (asset.name.contains("latest")
                    || asset.name.contains("app")
                    || asset.name.contains("update"))
        });

        let json_url = match json_asset {
            Some(asset) => {
                info!("Found JSON asset: {}", asset.name);
                &asset.browser_download_url
            }
            None => {
                info!("No JSON asset found, constructing URL from release tag");
                &format!(
                    "https://github.com/Zarestia-Dev/rclone-manager/releases/download/{}/latest.json",
                    release.tag_name
                )
            }
        };

        info!("Using update JSON URL: {}", json_url);

        let app_exit = app.clone();
        // Check for update using the specific release's JSON file
        let update = app
            .updater_builder()
            .endpoints(vec![json_url.parse()?])?
            .version_comparator(|current, update| update.version != current)
            .on_before_exit({
                move || {
                    let app = app_exit.clone();
                    warn!("App is about to exit for update installation");
                    tauri::async_runtime::spawn(async move {
                        app.state::<RcloneState>().set_shutting_down();
                        handle_shutdown(app).await;
                    });
                }
            })
            .build()?
            .check()
            .await?;

        let mut update = update;
        if let Some(ref mut u) = update {
            let current_version_segment = format!("/download/v{}/", u.version);
            let release_tag_segment = format!("/download/{}/", release.tag_name);

            let url_str = u.download_url.to_string();
            if url_str.contains(&current_version_segment) && !url_str.contains(&release_tag_segment)
            {
                let new_url = url_str.replace(&current_version_segment, &release_tag_segment);
                match url::Url::parse(&new_url) {
                    Ok(parsed) => {
                        info!(
                            "Adjusted update download URL to use release tag: {} -> {}",
                            u.download_url, parsed
                        );
                        u.download_url = parsed;
                    }
                    Err(err) => {
                        warn!(
                            "Failed to parse adjusted download URL '{}': {}",
                            new_url, err
                        );
                    }
                }
            }
        }

        let update_metadata = update.as_ref().map(|update| UpdateMetadata {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            release_tag: release.tag_name.clone(),
            release_notes: release.body.clone(),
            release_date: release.published_at.clone(),
            release_url: Some(release.html_url.clone()),
            update_in_progress: false,
            restart_required: false,
        });

        if let Some(ref metadata) = update_metadata {
            // Emit APP_EVENT to notify frontend
            if let Err(e) = app.emit(
                crate::utils::types::events::APP_EVENT,
                serde_json::json!({
                    "status": "update_found",
                    "data": metadata
                }),
            ) {
                log::warn!("Failed to emit app update event: {}", e);
            }

            send_notification(
                &app,
                "notification.title.updateFound",
                &serde_json::json!({
                    "key": "notification.body.updateFound",
                    "params": {
                        "version": &metadata.version
                    }
                })
                .to_string(),
            );
        }

        *pending_update
            .0
            .lock()
            .map_err(|e| Error::Mutex(format!("Failed to lock pending update: {e}")))? = update;

        Ok(update_metadata)
    }

    fn is_release_for_channel(release: &github_client::Release, channel: &str) -> bool {
        let tag = release.tag_name.to_lowercase();

        // 1. HEADLESS BUILD: Must have "headless-" prefix
        // This block only exists when compiling with "web-server"
        #[cfg(feature = "web-server")]
        if !tag.starts_with("headless-") {
            return false;
        }

        // 2. DESKTOP BUILD: Must NOT have "headless-" prefix
        // This block only exists when compiling WITHOUT "web-server"
        #[cfg(not(feature = "web-server"))]
        if tag.starts_with("headless-") {
            return false;
        }

        // 3. Filter by Channel (Stable vs Beta)
        match channel {
            "stable" => !release.prerelease && !tag.contains("beta"),
            "beta" => release.prerelease || tag.contains("beta"),
            _ => !release.prerelease && !tag.contains("beta"),
        }
    }

    #[tauri::command]
    pub async fn get_download_status(
        download_state: State<'_, DownloadState>,
    ) -> Result<DownloadStatus> {
        let downloaded = download_state.downloaded_bytes.load(Ordering::Relaxed);
        let total = download_state.total_bytes.load(Ordering::Relaxed);
        let is_complete = download_state.is_complete.load(Ordering::Relaxed);
        let is_failed = download_state.is_failed.load(Ordering::Relaxed);
        let failure_message = download_state
            .failure_message
            .lock()
            .map_err(|e| Error::Mutex(format!("Failed to lock failure message: {e}")))?
            .clone();

        let percentage = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };

        Ok(DownloadStatus {
            downloaded_bytes: downloaded,
            total_bytes: total,
            percentage,
            is_complete,
            is_failed,
            failure_message,
        })
    }

    #[tauri::command]
    pub async fn install_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
        download_state: State<'_, DownloadState>,
    ) -> Result<()> {
        let Some(update) = pending_update
            .0
            .lock()
            .map_err(|e| Error::Mutex(format!("Failed to lock pending update: {e}")))?
            .take()
        else {
            return Err(Error::NoPendingUpdate);
        };

        info!("Starting update installation...");
        info!("Preparing to download update from: {}", update.download_url);
        debug!("Update signature: {}", update.signature);

        send_notification(
            &app,
            "notification.title.updateStarted",
            &serde_json::json!({
                "key": "notification.body.updateStarted",
                "params": {
                    "version": &update.version
                }
            })
            .to_string(),
        );

        // Set update in progress flag
        app.state::<RcloneState>()
            .is_update_in_progress
            .store(true, Ordering::Relaxed);

        let client = reqwest::Client::new();
        match client.head(update.download_url.as_str()).send().await {
            Ok(resp) => {
                if let Err(e) = resp.error_for_status() {
                    warn!("HEAD check failed for {}: {}", update.download_url, e);
                    // Do not return an error, just a warning.
                    // This is a fix for some servers that do not support HEAD requests.
                }
            }
            Err(e) => {
                warn!("HEAD request failed for {}: {}", update.download_url, e);
            }
        }

        let res = update
            .download_and_install(
                |chunk_length, content_length| {
                    if let Some(content_length) = content_length {
                        download_state
                            .total_bytes
                            .store(content_length, Ordering::Relaxed);
                    }

                    let _new = download_state
                        .downloaded_bytes
                        .fetch_add(chunk_length as u64, Ordering::Relaxed)
                        + chunk_length as u64;
                },
                || {
                    download_state.is_complete.store(true, Ordering::Relaxed);
                    info!("Update download completed");
                },
            )
            .await;

        match res {
            Ok(_) => {
                info!("Update installation process completed");
                download_state.is_failed.store(false, Ordering::Relaxed);

                // Clear update in progress and set restart required flag
                let state = app.state::<RcloneState>();
                state.is_update_in_progress.store(false, Ordering::Relaxed);
                state.is_restart_required.store(true, Ordering::Relaxed);

                send_notification(
                    &app,
                    "notification.title.updateComplete",
                    "notification.body.updateComplete",
                );

                *download_state
                    .failure_message
                    .lock()
                    .map_err(|e| Error::Mutex(format!("Failed to lock failure message: {e}")))? =
                    None;
                Ok(())
            }
            Err(e) => {
                warn!("Update installation failed: {}", e);
                download_state.is_failed.store(true, Ordering::Relaxed);

                // Clear update in progress flag on failure
                app.state::<RcloneState>()
                    .is_update_in_progress
                    .store(false, Ordering::Relaxed);

                *download_state
                    .failure_message
                    .lock()
                    .map_err(|e| Error::Mutex(format!("Failed to lock failure message: {e}")))? =
                    Some(e.to_string());

                send_notification(
                    &app,
                    "notification.title.updateFailed",
                    &serde_json::json!({
                        "key": "notification.body.updateFailed",
                        "params": {
                            "error": e.to_string()
                        }
                    })
                    .to_string(),
                );

                Err(Error::Updater(e))
            }
        }
    }

    pub struct PendingUpdate(pub std::sync::Mutex<Option<Update>>);
}
