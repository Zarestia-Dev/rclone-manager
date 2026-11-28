//! Discover custom updates and adapt verified artifacts to platform installers.
use super::download::{cached_payload, fetch, store_payload};
use super::manifest::{
    ArtifactKind, CATALOG_NAME, MAX_MANIFEST_SIZE, Manifest, PUBLIC_KEY, select_manifest, target,
};
use super::policy::UpdatePolicy;
use crate::context::AppHandle;
use crate::utils::github_client::Release;
use crate::utils::types::updater::{AppUpdate, DownloadProgress, InstallOutcome, ReleaseArtifact};
use std::sync::Arc;

pub(crate) async fn check(
    app: &AppHandle,
    release: &Release,
    policy: &UpdatePolicy,
) -> Result<ReleaseArtifact, String> {
    let Some(kind) = policy.installation.artifact() else {
        // Nothing of ours updates it: the release is announced for a manual update.
        return Ok(ReleaseArtifact::NotBuilt);
    };
    let target = target();
    log::debug!(
        "Looking for signed update: release={}, kind={kind}, target={target}",
        release.tag_name
    );
    let Some(catalog) = release_file(release, CATALOG_NAME)? else {
        log::debug!("Release {} has no {CATALOG_NAME}", release.tag_name);
        return Ok(ReleaseArtifact::Unpublished);
    };
    let catalog = fetch(catalog, MAX_MANIFEST_SIZE, Box::new(|_, _| {})).await?;
    log::debug!("Read {} bytes from {}", catalog.len(), CATALOG_NAME);
    let selected = select_manifest(
        &catalog,
        super::clean_app_version(&release.tag_name),
        kind,
        &target,
        PUBLIC_KEY,
    )?;
    let Some(manifest) = selected else {
        log::debug!(
            "No signed manifest for {kind}-{target} in {}",
            release.tag_name
        );
        return Ok(ReleaseArtifact::NotBuilt);
    };
    // The release workflows upload every file of the catalog before it, so a
    // missing one is an error, never a release without an update.
    let download_url = release_file(release, &manifest.asset)?.ok_or_else(
        || crate::localized_error!("backendErrors.updater.missingAsset", "name" => &manifest.asset),
    )?;
    log::debug!(
        "Verified signed manifest: asset={}, download_bytes={}, installed_bytes={}",
        manifest.asset,
        manifest.download_size(),
        manifest.install_size()
    );
    let paths = crate::services::paths::AppPaths::from_app_handle(app)?;
    Ok(ReleaseArtifact::Found(Arc::new(SignedUpdate {
        manifest,
        download_url,
        cache_directory: paths.cache_dir.join("app-updates"),
    })))
}

/// The address GitHub gives the release file `name`.
fn release_file(release: &Release, name: &str) -> Result<Option<url::Url>, String> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .map(|asset| {
            asset
                .browser_download_url
                .parse()
                .map_err(|e: url::ParseError| e.to_string())
        })
        .transpose()
}

struct SignedUpdate {
    manifest: Manifest,
    download_url: url::Url,
    cache_directory: std::path::PathBuf,
}

impl SignedUpdate {
    /// Android's installer opens only its own file type, so the verified cache
    /// doubles as its input instead of a second copy.
    fn cache_path(&self) -> std::path::PathBuf {
        self.cache_directory.join(format!(
            "{}-{}.{}",
            self.manifest.kind,
            self.manifest.target,
            self.manifest.kind.extension()
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
    /// `download` verified `payload`; it is checked again, as Tauri does, so bytes
    /// that changed in memory since are never installed.
    fn install(&self, payload: &[u8]) -> Result<InstallOutcome, String> {
        self.manifest.verify_install_payload(payload, PUBLIC_KEY)?;
        if self.manifest.kind == ArtifactKind::Android {
            #[cfg(target_os = "android")]
            return super::android::install(&self.cache_path(), payload);
            #[cfg(not(target_os = "android"))]
            return Err(crate::localized_error!(
                "backendErrors.updater.unsupportedInstallation"
            ));
        }
        if self.manifest.kind.is_package() {
            return super::package::install(self.manifest.kind, payload);
        }
        super::binary::install(&self.manifest, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::super::policy::InstallationKind;
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
            InstallationKind::MacApp,
            InstallationKind::Appimage,
            InstallationKind::Deb,
            InstallationKind::Rpm,
            InstallationKind::Pacman,
            InstallationKind::Nsis,
            InstallationKind::Msi,
        ] {
            let policy = super::super::policy::test_policy(installation, false, None);
            assert!(matches!(
                check(&app, &release, &policy).await,
                Ok(ReleaseArtifact::Unpublished)
            ));
        }
    }

    #[tokio::test]
    async fn an_installation_the_core_never_updates_is_announced_for_a_manual_update() {
        let app = AppHandle::default();
        let release = Release {
            tag_name: "v99.0.0".into(),
            ..Default::default()
        };
        for installation in [
            InstallationKind::Flatpak,
            InstallationKind::Container,
            InstallationKind::Unknown,
        ] {
            let policy = super::super::policy::test_policy(installation, true, None);
            assert!(matches!(
                check(&app, &release, &policy).await,
                Ok(ReleaseArtifact::NotBuilt)
            ));
        }
    }
}
