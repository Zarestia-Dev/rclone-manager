//! Discover custom updates and adapt verified artifacts to platform installers.
use super::download::{cached_payload, fetch, release_asset, store_payload};
use super::manifest::{
    ArtifactKind, CATALOG_NAME, MAX_MANIFEST_SIZE, Manifest, PUBLIC_KEY, select_manifest, target,
};
use super::policy::{InstallationKind, UpdateMethod, UpdatePolicy};
use crate::context::AppHandle;
use crate::utils::github_client::Release;
use crate::utils::types::updater::{AppUpdate, DownloadProgress, InstallOutcome, PendingAppUpdate};
use std::sync::Arc;

fn kind(policy: &UpdatePolicy) -> ArtifactKind {
    match policy.installation {
        InstallationKind::Portable => ArtifactKind::Portable,
        InstallationKind::Android => ArtifactKind::Android,
        _ => ArtifactKind::Server,
    }
}

pub(crate) async fn check(
    app: &AppHandle,
    release: &Release,
    policy: &UpdatePolicy,
) -> Result<Option<PendingAppUpdate>, String> {
    let kind = kind(policy);
    let target = target();
    log::debug!(
        "Looking for signed update: release={}, kind={kind}, target={target}",
        release.tag_name
    );
    if !release.assets.iter().any(|a| a.name == CATALOG_NAME) {
        log::debug!("Release {} has no {CATALOG_NAME}", release.tag_name);
        return Ok(None);
    }
    let catalog = fetch(
        release_asset(release, CATALOG_NAME)?,
        MAX_MANIFEST_SIZE,
        Box::new(|_, _| {}),
    )
    .await?;
    log::debug!("Read {} bytes from {}", catalog.len(), CATALOG_NAME);
    let selected = select_manifest(
        &catalog,
        super::clean_app_version(&release.tag_name),
        kind,
        &target,
        PUBLIC_KEY,
    )?;
    let Some((manifest, bytes, signature)) = selected else {
        log::debug!(
            "No signed manifest for {kind}-{target} in {}",
            release.tag_name
        );
        return Ok(None);
    };
    if !release
        .assets
        .iter()
        .any(|asset| asset.name == manifest.asset)
    {
        log::debug!(
            "Signed manifest references absent release asset: {}",
            manifest.asset
        );
        return Ok(None);
    }
    let download_url = release_asset(release, &manifest.asset)?;
    log::debug!(
        "Verified signed manifest: asset={}, download_bytes={}, installed_bytes={}",
        manifest.asset,
        manifest.download_size(),
        manifest.install_size()
    );
    let paths = crate::services::paths::AppPaths::from_app_handle(app)?;
    Ok(Some(Arc::new(SignedUpdate {
        manifest,
        manifest_bytes: bytes,
        manifest_signature: signature,
        download_url,
        log_directory: paths.get_app_log_dir(),
        cache_directory: paths.cache_dir.join("app-updates"),
        method: policy.method,
    })))
}

struct SignedUpdate {
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    manifest_signature: String,
    download_url: url::Url,
    cache_directory: std::path::PathBuf,
    log_directory: std::path::PathBuf,
    method: UpdateMethod,
}

impl SignedUpdate {
    /// Android's installer only opens `.apk` files, so the verified cache doubles
    /// as the installer input instead of a second copy.
    fn cache_path(&self) -> std::path::PathBuf {
        let extension = if self.manifest.kind == ArtifactKind::Android {
            "apk"
        } else {
            "payload"
        };
        self.cache_directory.join(format!(
            "{}-{}.{extension}",
            self.manifest.kind, self.manifest.target
        ))
    }
}

#[async_trait::async_trait]
impl AppUpdate for SignedUpdate {
    fn version(&self) -> &str {
        &self.manifest.version
    }
    async fn download(&self, progress: DownloadProgress) -> Result<Vec<u8>, String> {
        let cache_path = self.cache_path();
        if let Some(bytes) = cached_payload(&self.manifest, &cache_path, PUBLIC_KEY).await {
            log::debug!(
                "Reusing verified update cache: {} ({} bytes)",
                cache_path.display(),
                bytes.len()
            );
            let mut progress = progress;
            progress(bytes.len(), Some(bytes.len() as u64));
            return Ok(bytes);
        }
        log::debug!(
            "No valid cached payload; downloading {} ({} bytes)",
            self.manifest.asset,
            self.manifest.download_size()
        );
        let bytes = fetch(
            self.download_url.clone(),
            self.manifest.download_size(),
            progress,
        )
        .await?;
        let manifest = self.manifest.clone();
        let bytes =
            crate::utils::spawn_blocking(move || manifest.prepare_download(bytes, PUBLIC_KEY))
                .await
                .map_err(|e| e.to_string())??;
        log::info!(
            "Update payload verified: asset={}, staged_bytes={}",
            self.manifest.asset,
            bytes.len()
        );
        store_payload(cache_path, bytes).await
    }
    fn install(&self, payload: &[u8]) -> Result<InstallOutcome, String> {
        self.manifest.verify_install_payload(payload, PUBLIC_KEY)?;
        log::debug!(
            "Reverified update payload before installation: {}",
            self.manifest.asset
        );
        if self.method == UpdateMethod::Android {
            #[cfg(target_os = "android")]
            return super::android::install(&self.cache_path(), payload);
            #[cfg(not(target_os = "android"))]
            return Err(crate::localized_error!(
                "backendErrors.updater.unsupportedInstallation"
            ));
        }
        super::binary::prepare(
            self.manifest.kind,
            &self.manifest_bytes,
            &self.manifest_signature,
            payload,
            &self.log_directory,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_release_without_custom_metadata_is_not_an_update_for_any_direct_installer() {
        let app = AppHandle::default();
        let release = Release {
            tag_name: "v99.0.0".into(),
            ..Default::default()
        };
        for installation in [
            InstallationKind::Portable,
            InstallationKind::Server,
            InstallationKind::Android,
        ] {
            let policy =
                super::super::policy::test_policy(installation, UpdateMethod::Binary, None);
            assert!(check(&app, &release, &policy).await.unwrap().is_none());
        }
    }
}
