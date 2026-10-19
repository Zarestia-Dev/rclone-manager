//! Native updater plugin integration and staged installation.
use crate::context::{AppHandle, BackendContext};
use crate::services::lifecycle::shutdown::handle_shutdown;
use crate::utils::{
    github_client,
    types::updater::{
        AppUpdate, DownloadProgress, InstallOutcome, PendingAppUpdate, UpdateMetadata,
    },
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

    fn install(&self, payload: &[u8]) -> std::result::Result<InstallOutcome, String> {
        self.0
            .install(payload)
            .map(|()| InstallOutcome::Restart)
            .map_err(|error| error.to_string())
    }
}

pub(crate) async fn check_native_updater(
    app: &AppHandle,
    release: &github_client::Release,
    metadata: &mut UpdateMetadata,
) -> Result<Option<PendingAppUpdate>, String> {
    let Some(manifest) = release.assets.iter().find(|a| a.name == "latest.json") else {
        log::debug!(
            "Release {} has no native updater manifest",
            release.tag_name
        );
        return Ok(None);
    };
    let json_url = &manifest.browser_download_url;

    info!("Using update manifest: {json_url}");

    let endpoint = json_url
        .parse()
        .map_err(|error: url::ParseError| error.to_string())?;
    let app_exit = app.clone();
    let updater_builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?;
    let expected = metadata.version.clone();

    let check_result = updater_builder
        .version_comparator(move |curr, upd| {
            manifest_matches_release(&curr.to_string(), &upd.version.to_string(), &expected)
        })
        .on_before_exit(move || {
            let app = app_exit.clone();
            warn!("Shutting down for update installation...");
            crate::utils::block_on(async move {
                handle_shutdown(app.backend().clone()).await;
            });
        })
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await;
    let check_result = match check_result {
        Ok(update) => update,
        Err(tauri_plugin_updater::Error::TargetNotFound(target)) => {
            log::debug!("Native updater manifest has no matching target: {target}");
            return Ok(None);
        }
        Err(error) => return Err(error.to_string()),
    };

    if let Some(mut u) = check_result {
        adjust_download_url(&mut u, &release.tag_name);
        if !release_has_download(release, &u.download_url) {
            log::debug!(
                "Native update references an absent release asset: {}",
                u.download_url
            );
            return Ok(None);
        }
        log::debug!(
            "Native update matched version {} and asset {}",
            u.version,
            u.download_url
        );
        metadata.version = u.version.clone();
        metadata.current_version = u.current_version.clone();
        Ok(Some(std::sync::Arc::new(NativeUpdate(u))))
    } else {
        Ok(None)
    }
}

fn release_has_download(release: &github_client::Release, download: &url::Url) -> bool {
    release.assets.iter().any(|asset| {
        std::iter::once(asset.browser_download_url.as_str())
            .chain(asset.api_url.as_deref())
            .any(|candidate| candidate.parse::<url::Url>().ok().as_ref() == Some(download))
    })
}

fn manifest_matches_release(current: &str, manifest: &str, expected: &str) -> bool {
    manifest == expected && crate::services::updates::is_version_newer(current, manifest)
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

#[cfg(test)]
mod tests {
    use super::{manifest_matches_release, release_has_download};

    #[test]
    fn native_update_requires_its_actual_asset_in_the_selected_release() {
        use crate::utils::github_client::{Asset, Release};
        let download =
            "https://github.com/Zarestia-Dev/rclone-manager/releases/download/v1.2.3/app.AppImage";
        let mut release = Release {
            tag_name: "v1.2.3".into(),
            prerelease: false,
            draft: false,
            assets: vec![],
            body: None,
            published_at: None,
            html_url: String::new(),
        };
        let url = download.parse().unwrap();
        assert!(!release_has_download(&release, &url));
        for other in [
            "not a URL",
            &format!("{download}.sig"),
            &download.replace("v1.2.3", "v1.2.4"),
        ] {
            release.assets = vec![Asset {
                name: "app.AppImage".into(),
                browser_download_url: other.into(),
                api_url: None,
            }];
            assert!(!release_has_download(&release, &url));
        }
        release.assets = vec![Asset {
            name: "app.AppImage".into(),
            browser_download_url: download.into(),
            api_url: Some(
                "https://api.github.com/repos/Zarestia-Dev/rclone-manager/releases/assets/42"
                    .into(),
            ),
        }];
        assert!(release_has_download(&release, &url));
        let api = release.assets[0].api_url.as_ref().unwrap().parse().unwrap();
        assert!(release_has_download(&release, &api));
        assert!(!release_has_download(
            &release,
            &"https://api.github.com/repos/Zarestia-Dev/rclone-manager/releases/assets/43"
                .parse()
                .unwrap()
        ));
    }

    #[test]
    fn native_manifest_cannot_substitute_a_different_version() {
        assert!(manifest_matches_release("1.0.0", "1.0.10", "1.0.10"));
        for (manifest, expected) in [
            ("0.9.0", "1.1.0"),
            ("1.0.0", "1.1.0"),
            ("1.2.0", "1.1.0"),
            ("1.1.0-beta.1", "1.1.0"),
        ] {
            assert!(!manifest_matches_release("1.0.0", manifest, expected));
        }
    }
}
