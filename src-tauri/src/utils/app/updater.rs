#[cfg(desktop)]
pub mod app_updates {
    use crate::core::lifecycle::shutdown::shutdown_app;
    use crate::utils::app::platform::relaunch_app;
    use crate::utils::types::updater::AppUpdaterState;
    use crate::utils::{
        app::notification::{NotificationEvent, notify},
        github_client,
        types::core::RcloneState,
    };
    use log::{debug, info, warn};
    use std::sync::atomic::Ordering;
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;

    #[derive(Debug, thiserror::Error)]
    pub enum Error {
        #[error(transparent)]
        Updater(#[from] tauri_plugin_updater::Error),
        #[error("there is no pending update")]
        NoPendingUpdate,
        #[error("update artifact is no longer available: {0}")]
        UpdateUnavailable(String),
        #[error("invalid URL: {0}")]
        InvalidUrl(#[from] url::ParseError),
        // Wrap the new GitHub client error
        #[error("GitHub API error: {0}")]
        GitHub(#[from] github_client::Error),
        #[error("mutex error: {0}")]
        Mutex(String),
        #[error("relaunch error: {0}")]
        Relaunch(String),
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
                Error::Relaunch(e) => {
                    format!("Relaunch failed: {}", e)
                }
                Error::UpdateUnavailable(e) => {
                    format!("Update unavailable: {}", e)
                }
            };
            serializer.serialize_str(&error_msg)
        }
    }

    type Result<T> = std::result::Result<T, Error>;

    #[derive(serde::Serialize, serde::Deserialize, Clone)]
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
    pub async fn fetch_update(app: AppHandle, channel: String) -> Result<Option<UpdateMetadata>> {
        let updater_state = app.state::<AppUpdaterState>();
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
        updater_state.total_bytes.store(0, Ordering::Relaxed);
        updater_state.downloaded_bytes.store(0, Ordering::Relaxed);
        if let Ok(mut failure_message) = updater_state.failure_message.lock() {
            *failure_message = None;
        }

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
                        let _ = shutdown_app(app).await;
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

        let update_metadata = if let Some(ref u) = update {
            // Fetch the specific release by tag to ensure we have the full body/notes
            let release_with_notes =
                match github_client::get_release_by_tag(owner, repo, &release.tag_name).await {
                    Ok(r) => r,
                    Err(e) => {
                        log::warn!(
                            "Failed to fetch full release notes for {}: {}",
                            release.tag_name,
                            e
                        );
                        release.clone()
                    }
                };

            Some(UpdateMetadata {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                release_tag: release_with_notes.tag_name.clone(),
                release_notes: release_with_notes.body,
                release_date: release_with_notes.published_at,
                release_url: Some(release_with_notes.html_url),
                update_in_progress: false,
                restart_required: false,
            })
        } else {
            None
        };

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

            notify(
                &app,
                NotificationEvent::AppUpdateAvailable {
                    version: metadata.version.clone(),
                },
            );
        }

        if let Ok(mut pending) = updater_state.pending_action.lock() {
            *pending = update;
        }

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
    pub async fn get_download_status(app: AppHandle) -> Result<DownloadStatus> {
        let updater_state = app.state::<AppUpdaterState>();
        let downloaded = updater_state.downloaded_bytes.load(Ordering::Relaxed);
        let total = updater_state.total_bytes.load(Ordering::Relaxed);
        let failure_message = updater_state
            .failure_message
            .lock()
            .map_err(|e| Error::Mutex(e.to_string()))?
            .clone();

        let is_complete = app
            .state::<RcloneState>()
            .is_restart_required
            .load(Ordering::Relaxed);
        let is_failed = failure_message.is_some();

        let percentage = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else if is_complete {
            100.0
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
    pub async fn install_update(app: AppHandle) -> Result<()> {
        let updater_state = app.state::<AppUpdaterState>();

        // Extract pending action
        let update = {
            let mut pending = updater_state
                .pending_action
                .lock()
                .map_err(|e| Error::Mutex(e.to_string()))?;
            if let Some(u) = pending.take() {
                u
            } else {
                return Err(Error::NoPendingUpdate);
            }
        };

        // Mark as updating
        updater_state.downloaded_bytes.store(0, Ordering::Relaxed);
        updater_state.total_bytes.store(0, Ordering::Relaxed);
        if let Ok(mut failure_msg) = updater_state.failure_message.lock() {
            *failure_msg = None;
        }

        info!("Starting update installation...");
        info!("Preparing to download update from: {}", update.download_url);
        debug!("Update signature: {}", update.signature);

        notify(
            &app,
            NotificationEvent::AppUpdateStarted {
                version: update.version.clone(),
            },
        );

        // Set update in progress flag
        app.state::<RcloneState>()
            .is_update_in_progress
            .store(true, Ordering::Relaxed);

        let client = reqwest::Client::new();
        match client.head(update.download_url.as_str()).send().await {
            Ok(resp) => {
                if matches!(
                    resp.status(),
                    reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE
                ) {
                    let message =
                        "Update file is no longer available. Please check for updates again.";
                    warn!("{} URL: {}", message, update.download_url);

                    if let Ok(mut pending) = updater_state.pending_action.lock() {
                        *pending = None;
                    }
                    if let Ok(mut signature_slot) = updater_state.signature.lock() {
                        *signature_slot = None;
                    }
                    if let Ok(mut failure_msg) = updater_state.failure_message.lock() {
                        *failure_msg = Some(message.to_string());
                    }

                    app.state::<RcloneState>()
                        .is_update_in_progress
                        .store(false, Ordering::Relaxed);

                    return Err(Error::UpdateUnavailable(message.to_string()));
                }

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

        let download_app = app.clone();

        let res = update
            .download(
                move |chunk_length, content_length| {
                    let st = download_app.state::<AppUpdaterState>();
                    st.downloaded_bytes
                        .fetch_add(chunk_length as u64, Ordering::Relaxed);
                    if let Some(total) = content_length {
                        st.total_bytes.store(total, Ordering::Relaxed);
                    }
                },
                move || {
                    info!("Update download completed");
                },
            )
            .await;

        match res {
            Ok(signature) => {
                info!("Update installation process completed");

                // Clear update in progress and set restart required flag
                let state = app.state::<RcloneState>();
                state.is_update_in_progress.store(false, Ordering::Relaxed);
                state.is_restart_required.store(true, Ordering::Relaxed);

                notify(
                    &app,
                    NotificationEvent::AppUpdateComplete {
                        version: update.version.clone(),
                    },
                );

                // Save update back to pending action for installation later
                if let Ok(mut signature_slot) = updater_state.signature.lock() {
                    *signature_slot = Some(signature);
                }

                if let Ok(mut pending) = updater_state.pending_action.lock() {
                    *pending = Some(update);
                }

                Ok(())
            }
            Err(e) => {
                warn!("Update installation failed: {}", e);

                // Preserve pending update so user can retry without re-checking
                if let Ok(mut pending) = updater_state.pending_action.lock() {
                    *pending = Some(update);
                }

                // Signature is invalid/absent on failed download
                if let Ok(mut signature_slot) = updater_state.signature.lock() {
                    *signature_slot = None;
                }

                // Record failure
                if let Ok(mut failure_msg) = updater_state.failure_message.lock() {
                    *failure_msg = Some(e.to_string());
                }

                // Clear update in progress flag on failure
                app.state::<RcloneState>()
                    .is_update_in_progress
                    .store(false, Ordering::Relaxed);

                notify(
                    &app,
                    NotificationEvent::AppUpdateFailed {
                        error: e.to_string(),
                    },
                );

                Err(Error::Updater(e))
            }
        }
    }

    #[tauri::command]
    pub async fn apply_app_update(app: AppHandle) -> Result<()> {
        let updater_state = app.state::<AppUpdaterState>();

        let (update, signature) = {
            let mut pending = updater_state
                .pending_action
                .lock()
                .map_err(|e| Error::Mutex(e.to_string()))?;
            let mut sig = updater_state
                .signature
                .lock()
                .map_err(|e| Error::Mutex(e.to_string()))?;

            if let (Some(u), Some(s)) = (pending.take(), sig.take()) {
                (u, s)
            } else {
                return Err(Error::NoPendingUpdate);
            }
        };

        info!("Starting update installation (relaunching)...");

        // Set update in progress flag
        app.state::<RcloneState>().set_update_in_progress(true);

        // Perform installation and relaunch
        if let Err(e) = update.install(signature) {
            app.state::<RcloneState>().set_update_in_progress(false);
            return Err(Error::Updater(e));
        }

        relaunch_app(app).await.map_err(Error::Relaunch)?;

        Ok(())
    }
}
