//! Signed, product-specific raw artifacts for portable, server and direct APK releases.
//! The manifest is signed as well as the artifact: its version/target/hash cannot
//! be substituted while replaying a previously signed executable.
use super::policy::{InstallationKind, UpdateMethod, UpdatePolicy};
use crate::context::AppHandle;
use crate::utils::github_client::{OWNER, REPO, Release};
use crate::utils::types::updater::{AppUpdate, DownloadProgress, InstallOutcome, PendingAppUpdate};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(crate) static PUBLIC_KEY: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../../desktop/tauri.conf.json"))
            .expect("Valid embedded Tauri configuration");
    config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("Configured updater public key")
        .to_owned()
});
const MAX_ARTIFACT_SIZE: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_SIZE: u64 = 64 * 1024;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: String,
    pub kind: String,
    pub target: String,
    pub asset: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
}

impl Manifest {
    pub(crate) fn validate(&self, version: &str, kind: &str, target: &str) -> Result<(), String> {
        if self.version != version
            || self.kind != kind
            || self.target != target
            || !super::is_version_newer(env!("CARGO_PKG_VERSION"), &self.version)
        {
            return Err("Update product, version or architecture does not match".into());
        }
        if self.size == 0
            || self.size > MAX_ARTIFACT_SIZE
            || !valid_asset_name(&self.asset)
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Invalid update artifact metadata".into());
        }
        Ok(())
    }

    pub(crate) fn verify_payload(&self, bytes: &[u8]) -> Result<(), String> {
        self.verify_payload_with_key(bytes, &PUBLIC_KEY)
    }

    pub(super) fn verify_payload_with_key(&self, bytes: &[u8], key: &str) -> Result<(), String> {
        if bytes.len() as u64 != self.size || sha256(bytes) != self.sha256 {
            return Err("Update size or checksum does not match the signed manifest".into());
        }
        verify_signature(bytes, &self.signature, key)
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

pub(crate) fn target() -> String {
    let arch = match std::env::consts::ARCH {
        "arm" => "armv7",
        "x86" => "i686",
        other => other,
    };
    format!("{}-{arch}", std::env::consts::OS)
}

fn kind(policy: &UpdatePolicy) -> &'static str {
    match policy.installation {
        InstallationKind::Portable => "portable",
        InstallationKind::Android => "android",
        _ => "server",
    }
}

pub(crate) fn verify_signature(bytes: &[u8], signature: &str, key: &str) -> Result<(), String> {
    use minisign_verify::{PublicKey, Signature};
    let decode = |text: &str| -> Result<String, String> {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    };
    let key = PublicKey::decode(&decode(key)?).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature, false)
        .map_err(|e| e.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("rclone-manager-updater")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(15 * 60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" || attempt.previous().len() >= 5 {
                attempt.error("Unsafe update redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch(
    url: url::Url,
    limit: u64,
    mut progress: DownloadProgress,
) -> Result<Vec<u8>, String> {
    use futures::StreamExt;
    if url.scheme() != "https" {
        return Err("Update download requires HTTPS".into());
    }
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let length = response.content_length();
    if length.is_some_and(|n| n > limit) {
        return Err("Update download exceeds size limit".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("Update download exceeds size limit".into());
        }
        progress(chunk.len(), length);
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn release_asset(release: &Release, name: &str) -> Result<url::Url, String> {
    if !valid_asset_name(name) {
        return Err("Invalid release asset name".into());
    }
    let mut url = url::Url::parse(&format!(
        "https://github.com/{OWNER}/{REPO}/releases/download/"
    ))
    .map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Invalid release URL")?
        .pop_if_empty()
        .push(&release.tag_name)
        .push(name);
    let expected = url.clone();
    let mut assets = release.assets.iter().filter(|a| a.name == name);
    let asset = assets
        .next()
        .ok_or_else(|| format!("Missing signed update asset: {name}"))?;
    if assets.next().is_some()
        || url::Url::parse(&asset.browser_download_url).ok().as_ref() != Some(&expected)
    {
        return Err("Ambiguous or unexpected release asset URL".into());
    }
    Ok(url)
}

pub(crate) async fn check(
    app: &AppHandle,
    release: &Release,
    policy: &UpdatePolicy,
) -> Result<Option<PendingAppUpdate>, String> {
    let kind = kind(policy);
    let target = target();
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
    verify_signature(&bytes, &signature, &PUBLIC_KEY)?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    manifest.validate(super::clean_app_version(&release.tag_name), kind, &target)?;
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
        if let Some(bytes) = cached_payload(&self.manifest, &cache_path, &PUBLIC_KEY).await {
            let mut progress = progress;
            progress(bytes.len(), Some(bytes.len() as u64));
            return Ok(bytes);
        }
        let bytes = fetch(self.download_url.clone(), self.manifest.size, progress).await?;
        self.manifest.verify_payload(&bytes)?;
        tokio::fs::create_dir_all(&self.cache_directory)
            .await
            .map_err(|e| e.to_string())?;
        let temporary =
            tempfile::NamedTempFile::new_in(&self.cache_directory).map_err(|e| e.to_string())?;
        tokio::fs::write(temporary.path(), &bytes)
            .await
            .map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(cache_path).map_err(|e| e.to_string())?;
        Ok(bytes)
    }
    fn install(&self, payload: &[u8]) -> Result<InstallOutcome, String> {
        self.manifest.verify_payload(payload)?;
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

async fn cached_payload(manifest: &Manifest, path: &std::path::Path, key: &str) -> Option<Vec<u8>> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    if !metadata.is_file() || metadata.len() != manifest.size {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    manifest.verify_payload_with_key(&bytes, key).ok()?;
    Some(bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_configs_share_the_production_verification_key() {
        let headless: serde_json::Value =
            serde_json::from_str(include_str!("../../../../desktop/tauri.conf.headless.json"))
                .unwrap();
        assert_eq!(
            headless["plugins"]["updater"]["pubkey"].as_str().unwrap(),
            super::PUBLIC_KEY.as_str()
        );
    }
    use super::*;

    #[test]
    fn release_assets_require_unique_names_and_the_selected_repository_and_tag() {
        let url = format!(
            "https://github.com/{OWNER}/{REPO}/releases/download/v99.0.0/portable-linux-x86_64.json"
        );
        let mut release = Release {
            tag_name: "v99.0.0".into(),
            prerelease: false,
            draft: false,
            assets: vec![crate::utils::github_client::Asset {
                name: "portable-linux-x86_64.json".into(),
                browser_download_url: url.clone(),
            }],
            body: None,
            published_at: None,
            html_url: String::new(),
        };
        assert_eq!(
            release_asset(&release, "portable-linux-x86_64.json")
                .unwrap()
                .as_str(),
            url
        );
        for wrong in [
            url.replace("https:", "http:"),
            url.replace("v99.0.0", "v98.0.0"),
            "https://example.invalid/update".into(),
        ] {
            release.assets[0].browser_download_url = wrong;
            assert!(release_asset(&release, "portable-linux-x86_64.json").is_err());
        }
        release.assets[0].browser_download_url = url;
        release.assets.push(release.assets[0].clone());
        assert!(release_asset(&release, "portable-linux-x86_64.json").is_err());
        assert!(release_asset(&release, "missing.json").is_err());
    }

    #[tokio::test]
    async fn cached_downloads_require_the_expected_size_hash_and_signature() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload");
        let manifest: Manifest =
            serde_json::from_slice(include_bytes!("fixtures/manifest.json")).unwrap();
        let key = include_str!("fixtures/public.key");
        assert!(cached_payload(&manifest, &path, key).await.is_none());
        std::fs::write(&path, include_bytes!("fixtures/payload.txt")).unwrap();
        assert!(cached_payload(&manifest, &path, key).await.is_some());
        assert!(
            cached_payload(&manifest, &path, &PUBLIC_KEY)
                .await
                .is_none()
        );
        let mut changed = include_bytes!("fixtures/payload.txt").to_vec();
        changed[0] ^= 1;
        std::fs::write(&path, changed).unwrap();
        assert!(cached_payload(&manifest, &path, key).await.is_none());
    }

    #[test]
    fn tauri_signer_fixtures_validate_and_tampering_or_wrong_keys_fail() {
        let bytes = include_bytes!("fixtures/manifest.json");
        let signature = include_str!("fixtures/manifest.json.sig");
        let key = include_str!("fixtures/public.key");
        verify_signature(bytes, signature, key).unwrap();
        assert!(verify_signature(bytes, signature, &PUBLIC_KEY).is_err());
        let mut changed = bytes.to_vec();
        changed[12] ^= 1;
        assert!(verify_signature(&changed, signature, key).is_err());
        let manifest: Manifest = serde_json::from_slice(bytes).unwrap();
        let payload = include_bytes!("fixtures/payload.txt");
        manifest.verify_payload_with_key(payload, key).unwrap();
        assert!(
            manifest
                .verify_payload_with_key(b"different executable", key)
                .is_err()
        );
        assert!(
            manifest
                .validate("99.0.0", "server", "linux-x86_64")
                .is_err()
        );
    }
    fn manifest() -> Manifest {
        Manifest {
            version: "99.0.0".into(),
            kind: "portable".into(),
            target: "linux-x86_64".into(),
            asset: "portable-linux-x86_64.bin".into(),
            size: 3,
            sha256: sha256(b"abc"),
            signature: "invalid".into(),
        }
    }
    #[test]
    fn metadata_is_bound_to_product_version_architecture_and_size() {
        let m = manifest();
        assert!(m.validate("99.0.0", "portable", "linux-x86_64").is_ok());
        for (v, k, t) in [
            ("99.0.1", "portable", "linux-x86_64"),
            ("99.0.0", "server", "linux-x86_64"),
            ("99.0.0", "portable", "linux-aarch64"),
        ] {
            assert!(m.validate(v, k, t).is_err());
        }
        for size in [0, MAX_ARTIFACT_SIZE + 1] {
            assert!(
                Manifest { size, ..manifest() }
                    .validate("99.0.0", "portable", "linux-x86_64")
                    .is_err()
            );
        }
    }
    #[test]
    fn unsafe_names_unsigned_and_tampered_payloads_are_rejected() {
        for name in [
            "",
            "../binary",
            "a/b",
            "C:\\app.exe",
            ".hidden",
            "a b",
            "ü.exe",
        ] {
            assert!(!valid_asset_name(name));
        }
        assert!(valid_asset_name("portable-windows-aarch64.exe"));
        assert!(manifest().verify_payload(b"abc").is_err()); // Correct hash is insufficient without a signature.
        assert!(manifest().verify_payload(b"xyz").is_err());
        assert!(verify_signature(b"abc", "bad signature", &PUBLIC_KEY).is_err());
    }
}
