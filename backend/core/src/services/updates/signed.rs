//! Discover custom updates and adapt verified artifacts to platform installers.
use super::download::{cached_payload, fetch, release_asset, store_payload};
use super::manifest::{
    CATALOG_NAME, MAX_MANIFEST_SIZE, Manifest, PUBLIC_KEY, select_manifest, target,
};
use super::policy::{InstallationKind, UpdateMethod, UpdatePolicy};
use crate::context::AppHandle;
use crate::utils::github_client::Release;
use crate::utils::types::updater::{AppUpdate, DownloadProgress, InstallOutcome, PendingAppUpdate};
use std::sync::Arc;

fn kind(policy: &UpdatePolicy) -> &'static str {
    match policy.installation {
        InstallationKind::Portable => "portable",
        InstallationKind::Android => "android",
        _ => "server",
    }
}

pub(crate) async fn check(
    app: &AppHandle,
    release: &Release,
    policy: &UpdatePolicy,
) -> Result<Option<PendingAppUpdate>, String> {
    let kind = kind(policy);
    let target = target();
    let selected = if release.assets.iter().any(|a| a.name == CATALOG_NAME) {
        let bytes = fetch(
            release_asset(release, CATALOG_NAME)?,
            MAX_MANIFEST_SIZE,
            Box::new(|_, _| {}),
        )
        .await?;
        select_manifest(
            &bytes,
            super::clean_app_version(&release.tag_name),
            kind,
            &target,
            PUBLIC_KEY,
        )?
    } else {
        // Retain support for older releases; never fall back after an invalid catalog.
        legacy_manifest(release, kind, &target).await?
    };
    let Some((manifest, bytes, signature)) = selected else {
        return Ok(None);
    };
    let download_url = release_asset(release, &manifest.asset)?;
    Ok(Some(Arc::new(SignedUpdate {
        manifest,
        manifest_bytes: bytes,
        manifest_signature: signature,
        download_url,
        cache_directory: crate::services::paths::AppPaths::from_app_handle(app)?
            .cache_dir
            .join("app-updates"),
        method: policy.method,
    })))
}

async fn legacy_manifest(
    release: &Release,
    kind: &str,
    target: &str,
) -> Result<Option<(Manifest, Vec<u8>, String)>, String> {
    let manifest_name = format!("{kind}-{target}.json");
    // Older published releases have no direct-update artifacts. Discovery still works.
    if !release.assets.iter().any(|a| a.name == manifest_name) {
        return Ok(None);
    }
    let bytes = fetch(
        release_asset(release, &manifest_name)?,
        MAX_MANIFEST_SIZE,
        Box::new(|_, _| {}),
    )
    .await?;
    let signature = fetch(
        release_asset(release, &format!("{manifest_name}.sig"))?,
        MAX_MANIFEST_SIZE,
        Box::new(|_, _| {}),
    )
    .await?;
    let signature = String::from_utf8(signature).map_err(|e| e.to_string())?;
    let manifest = Manifest::from_signed(&bytes, &signature, PUBLIC_KEY)?;
    manifest.validate(super::clean_app_version(&release.tag_name), kind, target)?;
    Ok(Some((manifest, bytes, signature)))
}

struct SignedUpdate {
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    manifest_signature: String,
    download_url: url::Url,
    cache_directory: std::path::PathBuf,
    method: UpdateMethod,
}

#[async_trait::async_trait]
impl AppUpdate for SignedUpdate {
    fn version(&self) -> &str {
        &self.manifest.version
    }
    fn download_url(&self) -> &url::Url {
        &self.download_url
    }
    async fn download(&self, progress: DownloadProgress) -> Result<Vec<u8>, String> {
        let cache_path = self.cache_directory.join(format!(
            "{}-{}.payload",
            self.manifest.kind, self.manifest.target
        ));
        if let Some(bytes) = cached_payload(&self.manifest, &cache_path, PUBLIC_KEY).await {
            let mut progress = progress;
            progress(bytes.len(), Some(bytes.len() as u64));
            return Ok(bytes);
        }
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
        store_payload(cache_path, bytes).await
    }
    fn install(&self, payload: &[u8]) -> Result<InstallOutcome, String> {
        self.manifest.verify_install_payload(payload, PUBLIC_KEY)?;
        if self.method == UpdateMethod::Android {
            #[cfg(target_os = "android")]
            return super::android::install(&self.cache_directory, payload);
            #[cfg(not(target_os = "android"))]
            return Err("Android installer is unavailable".into());
        }
        super::binary::prepare(
            &self.manifest.kind,
            &self.manifest_bytes,
            &self.manifest_signature,
            payload,
        )
    }
}
