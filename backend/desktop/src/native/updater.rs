//! Native updater plugin integration and staged installation.
use crate::context::{AppHandle, BackendContext};
use crate::services::lifecycle::shutdown::handle_shutdown;
use crate::utils::{
    github_client::{self, OWNER, REPO},
    types::updater::{AppUpdate, DownloadProgress, PendingAppUpdate, UpdateMetadata},
};
use log::{info, warn};
use tauri_plugin_updater::UpdaterExt;

struct NativeUpdate(tauri_plugin_updater::Update);

#[async_trait::async_trait]
impl AppUpdate for NativeUpdate {
    fn version(&self) -> &str {
        &self.0.version
    }

    fn download_url(&self) -> &url::Url {
        &self.0.download_url
    }

    async fn download(
        &self,
        on_progress: DownloadProgress,
    ) -> std::result::Result<Vec<u8>, String> {
        self.0
            .download(on_progress, || {
                info!("App update download finished successfully")
            })
            .await
            .map_err(|error| error.to_string())
    }

    fn install(&self, payload: Vec<u8>) -> std::result::Result<(), String> {
        self.0.install(payload).map_err(|error| error.to_string())
    }
}

pub(crate) async fn check_native_updater(
    app: &AppHandle,
    release: &github_client::Release,
    metadata: &mut UpdateMetadata,
) -> Option<PendingAppUpdate> {
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
                handle_shutdown(app.backend().clone()).await;
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
        Some(std::sync::Arc::new(NativeUpdate(u)))
    } else {
        None
    }
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
        log::debug!("Adjusted update URL: {} -> {}", update.download_url, parsed);
        update.download_url = parsed;
    }
}
