#[cfg(all(desktop, feature = "updater"))]
pub mod app_updates {
    use log::{debug, info, warn};
    use serde::Deserialize;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tauri::{AppHandle, Manager, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    use crate::{core::lifecycle::shutdown::handle_shutdown, utils::types::all_types::RcloneState};

    #[derive(Debug, thiserror::Error)]
    pub enum Error {
        #[error(transparent)]
        Updater(#[from] tauri_plugin_updater::Error),
        #[error("there is no pending update")]
        NoPendingUpdate,
        #[error("invalid URL: {0}")]
        InvalidUrl(#[from] url::ParseError),
        #[error("HTTP error: {0}")]
        Http(#[from] reqwest::Error),
    }

    impl serde::Serialize for Error {
        fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serializer.serialize_str(self.to_string().as_str())
        }
    }

    type Result<T> = std::result::Result<T, Error>;

    #[derive(Debug, Deserialize)]
    struct GitHubRelease {
        tag_name: String,
        prerelease: bool,
        draft: bool,
        assets: Vec<GitHubAsset>,
    }

    #[derive(Debug, Deserialize)]
    struct GitHubAsset {
        name: String,
        browser_download_url: String,
    }

    #[derive(Default)]
    pub struct DownloadState {
        pub total_bytes: AtomicU64,
        pub downloaded_bytes: AtomicU64,
        pub is_complete: AtomicBool,
        pub is_failed: AtomicBool,
        // store a short failure message; use a Mutex<String> for simplicity
        pub failure_message: std::sync::Mutex<Option<String>>,
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateMetadata {
        version: String,
        current_version: String,
        release_tag: String,
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
        // Reset download state
        download_state.total_bytes.store(0, Ordering::Relaxed);
        download_state.downloaded_bytes.store(0, Ordering::Relaxed);
        download_state.is_complete.store(false, Ordering::Relaxed);

        info!("Checking for updates on channel: {}", channel);

        // Get releases from GitHub API
        let client = reqwest::Client::new();
        // configure owner/repo and optional token (use org name as owner)
        let owner = "RClone-Manager";
        let repo = "rclone-manager";
        let url = format!(
            "https://api.github.com/repos/{}/{}/releases?per_page=100",
            owner, repo
        );

        let req = client
            .get(&url)
            .header("User-Agent", "Rclone-Manager")
            .header("Accept", "application/vnd.github.v3+json");

        let releases: Vec<GitHubRelease> = req.send().await?.json().await?;

        debug!("Found {:?} releases", releases);

        info!("Found {} releases", releases.len());

        // Filter and find the appropriate release for the channel
        let suitable_release = releases
            .into_iter()
            .filter(|release| !release.draft) // Skip draft releases
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
                // Fallback: construct the JSON URL based on release tag
                info!("No JSON asset found, constructing URL from release tag");
                &format!(
                    "https://github.com/RClone-Manger/rclone-manager/releases/download/{}/latest.json",
                    release.tag_name
                )
            }
        };

        info!("Using update JSON URL: {}", json_url);

        // Check for update using the specific release's JSON file
        let update = app
            .updater_builder()
            .endpoints(vec![json_url.parse()?])?
            .version_comparator(|current, update| {
                // Allow any version change (including downgrades for different channels)
                update.version != current
            })
            .on_before_exit({
                move || {
                    let app = app.clone();
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

        // If the updater selected a download URL that uses a different release tag
        // (for example `v0.1.4` instead of the actual `v0.1.4-beta`), fix the URL
        // by replacing the `/download/v{version}/` segment with the real release tag
        // from GitHub (`release.tag_name`). This handles cases where the JSON's
        // `version` field doesn't include the prerelease suffix.
        let mut update = update;
        if let Some(ref mut u) = update {
            // The updater usually places the version in the download path as `/download/v{version}/`.
            // Attempt to replace that with the actual release tag if they differ.
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
        });

        *pending_update.0.lock().unwrap() = update;

        Ok(update_metadata)
    }

    /// Determine if a release belongs to the specified channel
    fn is_release_for_channel(release: &GitHubRelease, channel: &str) -> bool {
        match channel {
            "stable" => {
                // Stable channel: not prerelease and doesn't contain beta in tag
                !release.prerelease && !release.tag_name.to_lowercase().contains("beta")
            }
            "beta" => {
                // Beta channel: prerelease OR contains beta in tag name
                release.prerelease || release.tag_name.to_lowercase().contains("beta")
            }
            _ => {
                // Default to stable behavior
                !release.prerelease && !release.tag_name.to_lowercase().contains("beta")
            }
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
        let failure_message = download_state.failure_message.lock().unwrap().clone();

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
        pending_update: State<'_, PendingUpdate>,
        download_state: State<'_, DownloadState>,
    ) -> Result<()> {
        let Some(update) = pending_update.0.lock().unwrap().take() else {
            return Err(Error::NoPendingUpdate);
        };

        info!("Starting update installation...");
        // Log chosen download URL and signature for diagnostics
        info!("Preparing to download update from: {}", update.download_url);
        debug!("Update signature: {}", update.signature);

        // Perform a quick HEAD request to validate the download URL before starting
        let client = reqwest::Client::new();
        match client.head(update.download_url.as_str()).send().await {
            Ok(resp) => {
                if let Err(e) = resp.error_for_status() {
                    warn!("HEAD check failed for {}: {}", update.download_url, e);
                    return Err(Error::Http(e));
                }
            }
            Err(e) => {
                warn!("HEAD request failed for {}: {}", update.download_url, e);
                return Err(Error::Http(e));
            }
        }

        // Wrap the download to log progress and capture errors
        let res = update
            .download_and_install(
                |chunk_length, content_length| {
                    // Store total bytes once
                    if let Some(content_length) = content_length {
                        download_state
                            .total_bytes
                            .store(content_length, Ordering::Relaxed);
                    }

                    // Increment downloaded bytes
                    let new = download_state
                        .downloaded_bytes
                        .fetch_add(chunk_length as u64, Ordering::Relaxed)
                        + chunk_length as u64;

                    // Log aggregated progress
                    let total = download_state.total_bytes.load(Ordering::Relaxed);
                    if total > 0 {
                        let _pct = (new as f64 / total as f64) * 100.0;
                    }
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
                // ensure not failed
                download_state.is_failed.store(false, Ordering::Relaxed);
                *download_state.failure_message.lock().unwrap() = None;
                Ok(())
            }
            Err(e) => {
                warn!("Update installation failed: {}", e);
                // store failure state and message so frontend can observe it
                download_state.is_failed.store(true, Ordering::Relaxed);
                *download_state.failure_message.lock().unwrap() = Some(e.to_string());
                Err(Error::Updater(e))
            }
        }
    }

    pub struct PendingUpdate(pub std::sync::Mutex<Option<Update>>);
}
