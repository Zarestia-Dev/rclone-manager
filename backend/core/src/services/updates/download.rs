//! Bounded HTTPS downloads and an authenticated, atomically written payload cache.
use super::manifest::{Manifest, valid_asset_name};
use crate::utils::github_client::{OWNER, REPO, Release};
use crate::utils::types::updater::DownloadProgress;
use std::path::{Path, PathBuf};

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::LazyLock<Result<reqwest::Client, String>> =
        std::sync::LazyLock::new(|| {
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
        });
    CLIENT.as_ref().map_err(Clone::clone)
}

pub(super) async fn fetch(
    url: url::Url,
    limit: u64,
    mut progress: DownloadProgress,
) -> Result<Vec<u8>, String> {
    use futures::StreamExt;
    if url.scheme() != "https" {
        return Err("Update download requires HTTPS".into());
    }
    log::debug!("Fetching update resource: {url}, size_limit={limit}");
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
    log::debug!("Update resource download complete: {} bytes", bytes.len());
    Ok(bytes)
}

pub(super) fn release_asset(release: &Release, name: &str) -> Result<url::Url, String> {
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

pub(super) async fn cached_payload(manifest: &Manifest, path: &Path, key: &str) -> Option<Vec<u8>> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let size = manifest.install_size();
    if !metadata.is_file() || metadata.len() != size {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    let manifest = manifest.clone();
    let key = key.to_owned();
    crate::utils::spawn_blocking(move || {
        manifest.verify_install_payload(&bytes, &key).ok()?;
        Some(bytes)
    })
    .await
    .ok()?
}

pub(super) async fn store_payload(path: PathBuf, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let directory = path.parent().ok_or("Missing cache directory")?.to_owned();
    let (temporary, bytes) = crate::utils::spawn_blocking(move || {
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        use std::io::Write;
        temporary.write_all(&bytes).map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        Ok::<_, String>((temporary, bytes))
    })
    .await
    .map_err(|e| e.to_string())??;
    // Only the still-active async owner may replace the cache. A cancelled owner
    // drops the blocking task's temporary file, even if its write finishes later.
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::super::manifest::PUBLIC_KEY;
    use super::*;

    #[test]
    fn cancelled_cache_writer_cannot_publish_after_a_retry() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("payload");
            std::fs::write(&path, b"existing cache").unwrap();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let blocker = crate::utils::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            });
            started_rx.await.unwrap();

            // Keep preparation queued until the async owner is cancelled and a
            // retry has replaced the cache, then let that detached write finish.
            let mut cancelled =
                Box::pin(store_payload(path.clone(), b"cancelled download".to_vec()));
            assert!(futures::poll!(cancelled.as_mut()).is_pending());
            drop(cancelled);
            std::fs::write(&path, b"newer download").unwrap();
            let drained = crate::utils::spawn_blocking(|| ());
            release_tx.send(()).unwrap();
            blocker.await.unwrap();
            drained.await.unwrap();

            assert_eq!(std::fs::read(&path).unwrap(), b"newer download");
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        });
    }

    #[tokio::test]
    async fn cache_round_trips_each_platforms_install_payload_and_rejects_tampering() {
        use super::super::manifest::test_portable_manifest;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("new-cache/payload");
        let key = include_str!("fixtures/portable-public.key");
        for (target, archive) in [
            (
                "linux-x86_64",
                include_bytes!("fixtures/portable-linux-x86_64-99.0.0.zip").as_slice(),
            ),
            (
                "windows-x86_64",
                include_bytes!("fixtures/portable-windows-x86_64-99.0.0.zip").as_slice(),
            ),
            (
                "macos-aarch64",
                include_bytes!("fixtures/portable-macos-aarch64-99.0.0.zip").as_slice(),
            ),
        ] {
            let manifest = test_portable_manifest(target);
            let payload = manifest.prepare_download(archive.to_vec(), key).unwrap();
            assert_eq!(manifest.download_size(), archive.len() as u64);
            assert_eq!(manifest.install_size(), payload.len() as u64);
            assert_eq!(
                payload.as_slice(),
                if target.starts_with("macos-") {
                    archive
                } else {
                    include_bytes!("fixtures/payload.txt").as_slice()
                }
            );
            assert_eq!(
                store_payload(path.clone(), payload.clone()).await.unwrap(),
                payload
            );
            assert_eq!(
                cached_payload(&manifest, &path, key).await.unwrap(),
                payload
            );
            let mut tampered = payload;
            tampered[0] ^= 1;
            std::fs::write(&path, tampered).unwrap();
            assert!(cached_payload(&manifest, &path, key).await.is_none());
            assert!(
                manifest
                    .prepare_download(archive.to_vec(), PUBLIC_KEY)
                    .is_err()
            );
        }
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        let invalid = root.path().join("file-not-directory");
        std::fs::write(&invalid, b"file").unwrap();
        assert!(
            store_payload(invalid.join("payload"), vec![1])
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn downloads_reject_insecure_urls_before_making_a_request() {
        assert!(
            fetch(
                "http://example.invalid/update".parse().unwrap(),
                10,
                Box::new(|_, _| {})
            )
            .await
            .is_err()
        );
    }
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
                api_url: None,
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
        assert!(cached_payload(&manifest, &path, PUBLIC_KEY).await.is_none());
        let mut changed = include_bytes!("fixtures/payload.txt").to_vec();
        changed[0] ^= 1;
        std::fs::write(&path, changed).unwrap();
        assert!(cached_payload(&manifest, &path, key).await.is_none());
    }
}
