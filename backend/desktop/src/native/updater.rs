//! Native updater plugin integration and staged installation.
use crate::context::{AppHandle, BackendContext};
use crate::services::lifecycle::shutdown::handle_shutdown;
use crate::utils::{
    github_client,
    types::updater::{AppUpdate, DownloadProgress, InstallOutcome, ReleaseArtifact},
};
use log::{info, warn};
use tauri_plugin_updater::UpdaterExt;

struct NativeUpdate(tauri_plugin_updater::Update);

#[async_trait::async_trait]
impl AppUpdate for NativeUpdate {
    fn version(&self) -> &str {
        &self.0.version
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
    expected: &str,
) -> Result<ReleaseArtifact, String> {
    let Some(manifest) = release.assets.iter().find(|a| a.name == "latest.json") else {
        log::debug!(
            "Release {} has no native updater manifest",
            release.tag_name
        );
        return Ok(ReleaseArtifact::Unpublished);
    };
    let json_url = &manifest.browser_download_url;

    info!("Using update manifest: {json_url}");

    let endpoint = json_url
        .parse()
        .map_err(|error: url::ParseError| error.to_string())?;
    let app_exit = app.clone();
    let updater_builder = app
        .updater_builder()
        // A stalled check would hold the updater lock; slow links still finish.
        .configure_client(github_client::detect_stalls)
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?;
    let expected = expected.to_owned();

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
            return Ok(ReleaseArtifact::NotBuilt);
        }
        Err(error) => return Err(error.to_string()),
    };

    // No update: the manifest belongs to another version than the release.
    Ok(check_result.map_or(ReleaseArtifact::Unpublished, |u| {
        log::debug!(
            "Native update matched version {} at {}",
            u.version,
            u.download_url
        );
        ReleaseArtifact::Found(std::sync::Arc::new(NativeUpdate(u)))
    }))
}

fn manifest_matches_release(current: &str, manifest: &str, expected: &str) -> bool {
    manifest == expected && crate::utils::version::is_update_candidate(current, manifest)
}

#[cfg(test)]
mod tests {
    use super::manifest_matches_release;

    #[test]
    fn native_config_shares_the_production_verification_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["updater"]["pubkey"].as_str().unwrap(),
            include_str!("../../../../resources/updater.pub").trim()
        );
    }

    #[test]
    fn native_manifest_cannot_substitute_a_different_version() {
        assert!(manifest_matches_release("1.0.0", "1.0.10", "1.0.10"));
        // Leaving a pre-release for an older stable release is a channel switch.
        assert!(manifest_matches_release("1.1.0-beta.1", "1.0.0", "1.0.0"));
        assert!(!manifest_matches_release("1.1.0", "1.0.0", "1.0.0"));
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
