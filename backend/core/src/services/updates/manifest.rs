//! Signed catalog metadata and artifact authentication, independent of transport.
//!
//! `scripts/create-update-manifest.cjs` checks what it signs. Here the signature,
//! the payload checksum and the version, kind and target asked for are checked;
//! fields this version does not know are ignored, and only this installation's
//! entry is read, so nothing a later release adds stops an installed version from
//! updating.
use crate::utils::archive::read_zip_member;
use base64::Engine;
use sha2::{Digest, Sha256};

pub(super) const PUBLIC_KEY: &str = include_str!("../../../../../resources/updater.pub");
pub(super) const MAX_MANIFEST_SIZE: u64 = 64 * 1024;
pub(super) const CATALOG_NAME: &str = "updater.json";

/// The product a signed artifact installs, spelled as in the catalog and plans.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Portable,
    Server,
    Android,
    /// A Linux AppImage, published as the release's own `.AppImage` file.
    Appimage,
    /// The server packages, installed by their installer.
    Deb,
    Rpm,
    /// The server's Arch Linux package.
    Pacman,
    Nsis,
    Msi,
}

impl ArtifactKind {
    /// The extension the kind's installer needs its file to have.
    pub(super) fn extension(self) -> &'static str {
        match self {
            Self::Android => "apk",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::Pacman => "pkg.tar.zst",
            Self::Nsis => "exe",
            Self::Msi => "msi",
            Self::Portable | Self::Server | Self::Appimage => "payload",
        }
    }
}

impl std::fmt::Display for ArtifactKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Portable => "portable",
            Self::Server => "server",
            Self::Android => "android",
            Self::Appimage => "appimage",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::Pacman => "pacman",
            Self::Nsis => "nsis",
            Self::Msi => "msi",
        })
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    version: String,
    /// Read only for this installation's entry, so another entry's shape never
    /// matters here.
    entries: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct SignedManifest {
    manifest: String,
    signature: String,
}

pub(super) fn select_manifest(
    bytes: &[u8],
    version: &str,
    kind: ArtifactKind,
    target: &str,
    key: &str,
) -> Result<Option<Manifest>, String> {
    let mut catalog: Catalog = serde_json::from_slice(bytes).map_err(verification_failed)?;
    if catalog.schema_version != 1 || catalog.version != version {
        return Err(verification_failed(
            "Custom update catalog schema or version does not match",
        ));
    }
    let Some(entry) = catalog.entries.remove(&format!("{kind}-{target}")) else {
        return Ok(None);
    };
    let entry: SignedManifest = serde_json::from_value(entry).map_err(verification_failed)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&entry.manifest)
        .map_err(verification_failed)?;
    let manifest = Manifest::from_signed(&bytes, &entry.signature, key)?;
    manifest.validate(version, kind, target)?;
    Ok(Some(manifest))
}

/// Versions up to 0.3.7-beta.1 reject a catalog, an entry or a manifest with a
/// field they do not know, and never update again. The catalog keeps exactly
/// `schemaVersion`, `version` and `entries`, every entry exactly `manifest` and
/// `signature`, and the manifests of the kinds they read (portable, server,
/// android, appimage, deb, rpm, nsis, msi) these fields. Only a new kind's
/// manifest may differ: those versions never decode it.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Manifest {
    pub version: String,
    pub kind: ArtifactKind,
    pub target: String,
    /// The release file, downloaded from the release by this name.
    pub asset: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) archive: Option<ArchiveInfo>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArchiveInfo {
    pub binary_path: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
}

impl ArchiveInfo {
    pub(super) fn verify(&self, bytes: &[u8], key: &str) -> Result<(), String> {
        if bytes.len() as u64 != self.size || sha256(bytes) != self.sha256 {
            return Err(verification_failed(
                "Portable ZIP size or checksum does not match",
            ));
        }
        verify_signature(bytes, &self.signature, key)
    }
}

impl Manifest {
    pub(super) fn from_signed(bytes: &[u8], signature: &str, key: &str) -> Result<Self, String> {
        verify_signature(bytes, signature, key)?;
        serde_json::from_slice(bytes).map_err(verification_failed)
    }

    pub(super) fn download_size(&self) -> u64 {
        self.archive
            .as_ref()
            .map_or(self.size, |archive| archive.size)
    }

    pub(super) fn install_size(&self) -> u64 {
        if self.bundle_root().is_some() {
            self.download_size()
        } else {
            self.size
        }
    }

    /// Windows/Linux install just the binary; macOS installs the complete authenticated app.
    pub(super) fn prepare_download(&self, bytes: Vec<u8>, key: &str) -> Result<Vec<u8>, String> {
        if self.archive.is_some() {
            let binary = self.read_verified_archive(&bytes, key)?;
            Ok(if self.bundle_root().is_some() {
                bytes
            } else {
                binary
            })
        } else {
            self.verify_payload_with_key(&bytes, key)?;
            Ok(bytes)
        }
    }

    fn read_verified_archive(&self, bytes: &[u8], key: &str) -> Result<Vec<u8>, String> {
        let archive = self
            .archive
            .as_ref()
            .ok_or_else(|| verification_failed("Missing portable ZIP"))?;
        archive.verify(bytes, key)?;
        log::debug!(
            "Verified portable ZIP size, SHA-256 and signature: {} ({} bytes)",
            self.asset,
            bytes.len()
        );
        let binary = read_zip_member(bytes, &archive.binary_path, self.size, self.bundle_root())
            .map_err(verification_failed)?;
        self.verify_payload_with_key(&binary, key)?;
        log::debug!(
            "Verified ZIP member size, SHA-256 and signature: {} ({} bytes)",
            archive.binary_path,
            binary.len()
        );
        Ok(binary)
    }

    pub(super) fn bundle_root(&self) -> Option<&str> {
        if self.kind != ArtifactKind::Portable || !self.target.starts_with("macos-") {
            return None;
        }
        let path = &self.archive.as_ref()?.binary_path;
        let (root, member) = path.split_once('/')?;
        (root.len() > 4 && root.ends_with(".app") && member == "Contents/MacOS/rclone-manager")
            .then_some(root)
    }

    pub(super) fn verify_install_payload(&self, bytes: &[u8], key: &str) -> Result<(), String> {
        if self.bundle_root().is_some() {
            self.read_verified_archive(bytes, key).map(|_| ())
        } else {
            self.verify_payload_with_key(bytes, key)
        }
    }
    pub(super) fn validate(
        &self,
        version: &str,
        kind: ArtifactKind,
        target: &str,
    ) -> Result<(), String> {
        if self.version != version || self.kind != kind || self.target != target {
            return Err(verification_failed(
                "Update product, version or architecture does not match",
            ));
        }
        Ok(())
    }

    pub(super) fn verify_payload_with_key(&self, bytes: &[u8], key: &str) -> Result<(), String> {
        if bytes.len() as u64 != self.size || sha256(bytes) != self.sha256 {
            return Err(verification_failed(
                "Update size or checksum does not match the signed manifest",
            ));
        }
        verify_signature(bytes, &self.signature, key)
    }
}

/// Every authentication failure reads the same to the user; the log says which
/// check failed.
pub(super) fn verification_failed(detail: impl std::fmt::Display) -> String {
    log::warn!("Update verification failed: {detail}");
    crate::localized_error!("backendErrors.updater.verificationFailed")
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn target() -> String {
    let arch = match std::env::consts::ARCH {
        "arm" => "armv7",
        "x86" => "i686",
        other => other,
    };
    format!("{}-{arch}", std::env::consts::OS)
}

fn verify_signature(bytes: &[u8], signature: &str, key: &str) -> Result<(), String> {
    use minisign_verify::{PublicKey, Signature};
    let decode = |text: &str| -> Result<String, String> {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .map_err(verification_failed)?,
        )
        .map_err(verification_failed)
    };
    let key = PublicKey::decode(&decode(key)?).map_err(verification_failed)?;
    let signature = Signature::decode(&decode(signature)?).map_err(verification_failed)?;
    key.verify(bytes, &signature, false)
        .map_err(verification_failed)
}

#[cfg(test)]
pub(super) fn test_portable_manifest(target: &str) -> Manifest {
    select_manifest(
        include_bytes!("fixtures/portable-catalog.json"),
        "99.0.0",
        ArtifactKind::Portable,
        target,
        include_str!("fixtures/portable-public.key"),
    )
    .unwrap()
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_payload_preparation_preserves_verified_binary_bytes() {
        let manifest: Manifest =
            serde_json::from_slice(include_bytes!("fixtures/manifest.json")).unwrap();
        let payload = include_bytes!("fixtures/payload.txt");
        let key = include_str!("fixtures/public.key");
        assert_eq!(
            manifest.prepare_download(payload.to_vec(), key).unwrap(),
            payload
        );
        assert_eq!(manifest.download_size(), payload.len() as u64);
        assert_eq!(manifest.install_size(), manifest.download_size());
        assert!(
            manifest
                .prepare_download(b"tampered".to_vec(), key)
                .is_err()
        );
    }

    #[test]
    fn fields_added_by_later_releases_are_ignored() {
        let mut value = serde_json::to_value(test_portable_manifest("linux-x86_64")).unwrap();
        value["added"] = serde_json::json!(true);
        value["archive"]["added"] = serde_json::json!(true);
        let manifest: Manifest = serde_json::from_value(value).unwrap();
        manifest
            .validate("99.0.0", ArtifactKind::Portable, "linux-x86_64")
            .unwrap();

        let mut catalog = catalog_fixture();
        catalog["added"] = serde_json::json!(true);
        catalog["entries"]["portable-linux-x86_64"]["added"] = serde_json::json!(true);
        // An entry of a kind this version does not know, in a shape of its own.
        catalog["entries"]["future-linux-x86_64"] = serde_json::json!({ "parts": [1, 2] });
        assert!(
            select_manifest(
                &serde_json::to_vec(&catalog).unwrap(),
                "99.0.0",
                ArtifactKind::Portable,
                "linux-x86_64",
                include_str!("fixtures/public.key")
            )
            .unwrap()
            .is_some()
        );
    }
    #[test]
    fn portable_zips_and_their_inner_binaries_are_independently_authenticated() {
        let key = include_str!("fixtures/portable-public.key");
        for (target, bytes) in [
            (
                "windows-x86_64",
                include_bytes!("fixtures/portable-windows-x86_64-99.0.0.zip").as_slice(),
            ),
            (
                "linux-x86_64",
                include_bytes!("fixtures/portable-linux-x86_64-99.0.0.zip").as_slice(),
            ),
            (
                "macos-aarch64",
                include_bytes!("fixtures/portable-macos-aarch64-99.0.0.zip").as_slice(),
            ),
        ] {
            let manifest = test_portable_manifest(target);
            let archive = manifest.archive.as_ref().unwrap();
            archive.verify(bytes, key).unwrap();
            let binary = read_zip_member(
                bytes,
                &archive.binary_path,
                manifest.size,
                manifest.bundle_root(),
            )
            .unwrap();
            assert_eq!(binary, include_bytes!("fixtures/payload.txt"));
            manifest.verify_payload_with_key(&binary, key).unwrap();
            assert!(archive.verify(bytes, PUBLIC_KEY).is_err());
            let mut tampered = bytes.to_vec();
            tampered[0] ^= 1;
            assert!(archive.verify(&tampered, key).is_err());
            let mut fake_hash = archive.clone();
            fake_hash.sha256 = sha256(&tampered);
            assert!(fake_hash.verify(&tampered, key).is_err());
            let mut wrong_binary = manifest.clone();
            wrong_binary.signature = String::new();
            assert!(wrong_binary.verify_payload_with_key(&binary, key).is_err());
            if manifest.bundle_root().is_some() {
                manifest.verify_install_payload(bytes, key).unwrap();
            } else {
                manifest.verify_install_payload(&binary, key).unwrap();
            }
        }
    }

    fn server_manifest(target: &str) -> Manifest {
        select_manifest(
            include_bytes!("fixtures/server-catalog.json"),
            "99.0.0",
            ArtifactKind::Server,
            target,
            include_str!("fixtures/server-public.key"),
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn server_zips_install_only_their_authenticated_executable_on_every_platform() {
        let key = include_str!("fixtures/server-public.key");
        for (target, bytes) in [
            (
                "linux-x86_64",
                include_bytes!("fixtures/server-linux-x86_64-99.0.0.zip").as_slice(),
            ),
            (
                "macos-aarch64",
                include_bytes!("fixtures/server-macos-aarch64-99.0.0.zip").as_slice(),
            ),
            (
                "windows-x86_64",
                include_bytes!("fixtures/server-windows-x86_64-99.0.0.zip").as_slice(),
            ),
        ] {
            let manifest = server_manifest(target);
            assert_eq!(manifest.asset, format!("server-{target}-99.0.0.zip"));
            // A server ZIP never carries an app bundle, even on macOS.
            assert!(manifest.bundle_root().is_none());
            assert_eq!(manifest.download_size(), bytes.len() as u64);
            let payload = manifest.prepare_download(bytes.to_vec(), key).unwrap();
            assert_eq!(payload, include_bytes!("fixtures/payload.txt"));
            assert_eq!(manifest.install_size(), payload.len() as u64);
            manifest.verify_install_payload(&payload, key).unwrap();
            assert!(
                manifest
                    .prepare_download(bytes.to_vec(), PUBLIC_KEY)
                    .is_err()
            );
            let mut tampered = bytes.to_vec();
            tampered[0] ^= 1;
            assert!(manifest.prepare_download(tampered, key).is_err());
        }
    }

    #[test]
    fn appimages_install_the_signed_release_bundle_itself() {
        let key = include_str!("fixtures/appimage-public.key");
        let manifest = select_manifest(
            include_bytes!("fixtures/appimage-catalog.json"),
            "99.0.0",
            ArtifactKind::Appimage,
            "linux-x86_64",
            key,
        )
        .unwrap()
        .unwrap();
        assert_eq!(manifest.asset, "RClone.Manager_99.0.0_amd64.AppImage");
        let payload = include_bytes!("fixtures/payload.txt");
        assert_eq!(
            manifest.prepare_download(payload.to_vec(), key).unwrap(),
            payload
        );
        manifest.verify_install_payload(payload, key).unwrap();
        assert!(manifest.verify_install_payload(b"tampered", key).is_err());
        assert!(
            manifest
                .verify_install_payload(payload, PUBLIC_KEY)
                .is_err()
        );
        // The catalog entry is bound to its kind and architecture.
        for (kind, target) in [
            (ArtifactKind::Portable, "linux-x86_64"),
            (ArtifactKind::Appimage, "linux-aarch64"),
        ] {
            assert!(
                select_manifest(
                    include_bytes!("fixtures/appimage-catalog.json"),
                    "99.0.0",
                    kind,
                    target,
                    key
                )
                .unwrap()
                .is_none()
            );
        }
        manifest
            .validate("99.0.0", ArtifactKind::Appimage, "linux-x86_64")
            .unwrap();
    }

    fn catalog_fixture() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "version": "99.0.0",
            "entries": {
                "portable-linux-x86_64": {
                    "manifest": base64::engine::general_purpose::STANDARD.encode(include_bytes!("fixtures/manifest.json")),
                    "signature": include_str!("fixtures/manifest.json.sig").trim(),
                }
            }
        })
    }

    #[test]
    fn catalog_entries_are_bound_to_their_kind_target_version_and_key() {
        let catalog = serde_json::to_vec(&catalog_fixture()).unwrap();
        let manifest = select_manifest(
            &catalog,
            "99.0.0",
            ArtifactKind::Portable,
            "linux-x86_64",
            include_str!("fixtures/public.key"),
        )
        .unwrap()
        .unwrap();
        manifest
            .verify_payload_with_key(
                include_bytes!("fixtures/payload.txt"),
                include_str!("fixtures/public.key"),
            )
            .unwrap();
        assert!(
            select_manifest(
                &catalog,
                "99.0.0",
                ArtifactKind::Server,
                "linux-x86_64",
                PUBLIC_KEY
            )
            .unwrap()
            .is_none()
        );
        assert!(
            select_manifest(
                &catalog,
                "99.0.0",
                ArtifactKind::Portable,
                "linux-aarch64",
                PUBLIC_KEY
            )
            .unwrap()
            .is_none()
        );
        assert!(
            select_manifest(
                &catalog,
                "99.0.1",
                ArtifactKind::Portable,
                "linux-x86_64",
                include_str!("fixtures/public.key")
            )
            .is_err()
        );
        assert!(
            select_manifest(
                &catalog,
                "99.0.0",
                ArtifactKind::Portable,
                "linux-x86_64",
                PUBLIC_KEY
            )
            .is_err()
        );
    }

    #[test]
    fn catalog_rejects_tampering_relabeling_invalid_schemas_and_malformed_entries() {
        let mut bad_catalogs = Vec::new();
        let mut catalog = catalog_fixture();
        catalog["schemaVersion"] = serde_json::json!(2);
        bad_catalogs.push(catalog);
        for (field, value) in [("manifest", "%%%"), ("signature", ""), ("manifest", "e30=")] {
            let mut catalog = catalog_fixture();
            catalog["entries"]["portable-linux-x86_64"][field] = serde_json::json!(value);
            bad_catalogs.push(catalog);
        }
        let mut catalog = catalog_fixture();
        let mut bytes = include_bytes!("fixtures/manifest.json").to_vec();
        bytes[12] ^= 1;
        catalog["entries"]["portable-linux-x86_64"]["manifest"] =
            serde_json::json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        bad_catalogs.push(catalog);
        bad_catalogs.push(serde_json::Value::Null);
        for catalog in bad_catalogs {
            assert!(
                select_manifest(
                    &serde_json::to_vec(&catalog).unwrap(),
                    "99.0.0",
                    ArtifactKind::Portable,
                    "linux-x86_64",
                    include_str!("fixtures/public.key")
                )
                .is_err()
            );
        }
        let mut catalog = catalog_fixture();
        catalog["entries"]["server-linux-x86_64"] =
            catalog["entries"]["portable-linux-x86_64"].take();
        assert!(
            select_manifest(
                &serde_json::to_vec(&catalog).unwrap(),
                "99.0.0",
                ArtifactKind::Server,
                "linux-x86_64",
                include_str!("fixtures/public.key")
            )
            .is_err()
        );
    }

    #[test]
    fn tauri_signer_fixtures_validate_and_tampering_or_wrong_keys_fail() {
        let bytes = include_bytes!("fixtures/manifest.json");
        let signature = include_str!("fixtures/manifest.json.sig");
        let key = include_str!("fixtures/public.key");
        verify_signature(bytes, signature, key).unwrap();
        assert!(verify_signature(bytes, signature, PUBLIC_KEY).is_err());
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
                .validate("99.0.0", ArtifactKind::Server, "linux-x86_64")
                .is_err()
        );
    }
    fn manifest() -> Manifest {
        Manifest {
            version: "99.0.0".into(),
            kind: ArtifactKind::Portable,
            target: "linux-x86_64".into(),
            asset: "portable-linux-x86_64.bin".into(),
            size: 3,
            sha256: sha256(b"abc"),
            signature: "invalid".into(),
            archive: None,
        }
    }
    #[test]
    fn metadata_is_bound_to_product_version_and_architecture() {
        let m = manifest();
        assert!(
            m.validate("99.0.0", ArtifactKind::Portable, "linux-x86_64")
                .is_ok()
        );
        for (v, k, t) in [
            ("99.0.1", ArtifactKind::Portable, "linux-x86_64"),
            ("99.0.0", ArtifactKind::Server, "linux-x86_64"),
            ("99.0.0", ArtifactKind::Portable, "linux-aarch64"),
        ] {
            assert!(m.validate(v, k, t).is_err());
        }
    }
    #[test]
    fn unsigned_and_tampered_payloads_are_rejected() {
        assert!(
            manifest()
                .verify_payload_with_key(b"abc", PUBLIC_KEY)
                .is_err()
        ); // Correct hash is insufficient without a signature.
        assert!(
            manifest()
                .verify_payload_with_key(b"xyz", PUBLIC_KEY)
                .is_err()
        );
        assert!(verify_signature(b"abc", "bad signature", PUBLIC_KEY).is_err());
    }
}
