//! Signed catalog metadata and artifact authentication, independent of transport.
use crate::utils::archive::{read_zip_member, safe_member_path};
use base64::Engine;
use sha2::{Digest, Sha256};

pub(super) const PUBLIC_KEY: &str = include_str!("../../../../../resources/updater.pub");
pub(super) const MAX_ARTIFACT_SIZE: u64 = 512 * 1024 * 1024;
pub(super) const MAX_MANIFEST_SIZE: u64 = 64 * 1024;
pub(super) const CATALOG_NAME: &str = "updater.json";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u32,
    version: String,
    entries: std::collections::HashMap<String, SignedManifest>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedManifest {
    manifest: String,
    signature: String,
}

pub(super) fn select_manifest(
    bytes: &[u8],
    version: &str,
    kind: &str,
    target: &str,
    key: &str,
) -> Result<Option<(Manifest, Vec<u8>, String)>, String> {
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if catalog.schema_version != 1 || catalog.version != version {
        return Err("Custom update catalog schema or version does not match".into());
    }
    let Some(entry) = catalog.entries.get(&format!("{kind}-{target}")) else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&entry.manifest)
        .map_err(|e| e.to_string())?;
    let manifest = Manifest::from_signed(&bytes, &entry.signature, key)?;
    manifest.validate(version, kind, target)?;
    Ok(Some((manifest, bytes, entry.signature.clone())))
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub version: String,
    pub kind: String,
    pub target: String,
    pub asset: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) archive: Option<ArchiveInfo>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ArchiveInfo {
    pub binary_path: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
}

impl ArchiveInfo {
    fn validate(&self, manifest: &Manifest) -> Result<(), String> {
        if manifest.kind != "portable"
            || !manifest.asset.ends_with(".zip")
            || !["windows-", "linux-", "macos-"]
                .iter()
                .any(|prefix| manifest.target.starts_with(prefix))
            || !valid_artifact(self.size, &self.sha256, &self.signature)
            || !safe_member_path(&self.binary_path)
            || self.binary_path.ends_with('/')
            || (manifest.target.starts_with("macos-") && manifest.bundle_root().is_none())
        {
            return Err("Invalid portable ZIP metadata".into());
        }
        Ok(())
    }

    pub(super) fn verify(&self, bytes: &[u8], key: &str) -> Result<(), String> {
        if bytes.len() as u64 != self.size || sha256(bytes) != self.sha256 {
            return Err("Portable ZIP size or checksum does not match".into());
        }
        verify_signature(bytes, &self.signature, key)
    }
}

impl Manifest {
    pub(super) fn from_signed(bytes: &[u8], signature: &str, key: &str) -> Result<Self, String> {
        verify_signature(bytes, signature, key)?;
        serde_json::from_slice(bytes).map_err(|e| e.to_string())
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
        let archive = self.archive.as_ref().ok_or("Missing portable ZIP")?;
        archive.verify(bytes, key)?;
        let binary = read_zip_member(bytes, &archive.binary_path, self.size, self.bundle_root())?;
        self.verify_payload_with_key(&binary, key)?;
        Ok(binary)
    }

    pub(super) fn bundle_root(&self) -> Option<&str> {
        if self.kind != "portable" || !self.target.starts_with("macos-") {
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
    pub(super) fn validate(&self, version: &str, kind: &str, target: &str) -> Result<(), String> {
        if self.version != version
            || self.kind != kind
            || self.target != target
            || !super::is_version_newer(env!("CARGO_PKG_VERSION"), &self.version)
        {
            return Err("Update product, version or architecture does not match".into());
        }
        if !valid_asset_name(&self.asset)
            || !valid_artifact(self.size, &self.sha256, &self.signature)
        {
            return Err("Invalid update artifact metadata".into());
        }
        if let Some(archive) = &self.archive {
            archive.validate(self)?;
        }
        Ok(())
    }

    pub(super) fn verify_payload_with_key(&self, bytes: &[u8], key: &str) -> Result<(), String> {
        if bytes.len() as u64 != self.size || sha256(bytes) != self.sha256 {
            return Err("Update size or checksum does not match the signed manifest".into());
        }
        verify_signature(bytes, &self.signature, key)
    }
}

fn valid_artifact(size: u64, hash: &str, signature: &str) -> bool {
    size > 0
        && size <= MAX_ARTIFACT_SIZE
        && hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && !signature.trim().is_empty()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
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
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    };
    let key = PublicKey::decode(&decode(key)?).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature, false)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(super) fn test_portable_manifest(target: &str) -> Manifest {
    select_manifest(
        include_bytes!("fixtures/portable-catalog.json"),
        "99.0.0",
        "portable",
        target,
        include_str!("fixtures/portable-public.key"),
    )
    .unwrap()
    .unwrap()
    .0
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
    fn metadata_rejects_unknown_fields_and_empty_signatures() {
        let mut value = serde_json::to_value(test_portable_manifest("linux-x86_64")).unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Manifest>(value.clone()).is_err());
        value.as_object_mut().unwrap().remove("unexpected");
        value["archive"]["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Manifest>(value.clone()).is_err());
        value["archive"]
            .as_object_mut()
            .unwrap()
            .remove("unexpected");
        value["signature"] = serde_json::json!("");
        let manifest: Manifest = serde_json::from_value(value).unwrap();
        assert!(
            manifest
                .validate("99.0.0", "portable", "linux-x86_64")
                .is_err()
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

    #[test]
    fn archive_metadata_rejects_paths_wrong_products_and_missing_authentication() {
        let manifest = test_portable_manifest("linux-x86_64");
        let archive = manifest.archive.as_ref().unwrap();
        for path in ["", "../binary", "/absolute", "C:/binary", "a\\b", "a//b"] {
            let mut invalid = archive.clone();
            invalid.binary_path = path.into();
            assert!(invalid.validate(&manifest).is_err());
        }
        for size in [0, MAX_ARTIFACT_SIZE + 1] {
            let mut invalid = archive.clone();
            invalid.size = size;
            assert!(invalid.validate(&manifest).is_err());
        }
        let mut invalid = archive.clone();
        invalid.signature.clear();
        assert!(invalid.validate(&manifest).is_err());
        let mut invalid = manifest.clone();
        invalid.kind = "server".into();
        assert!(archive.validate(&invalid).is_err());
        let mut invalid = manifest.clone();
        invalid.asset = "portable.tar.gz".into();
        assert!(archive.validate(&invalid).is_err());
        let mut invalid = manifest;
        invalid.target = "macos-aarch64".into();
        assert!(
            invalid
                .archive
                .as_ref()
                .unwrap()
                .validate(&invalid)
                .is_err()
        );
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
    fn catalog_preserves_exact_signed_bytes_for_the_existing_install_helper() {
        let catalog = serde_json::to_vec(&catalog_fixture()).unwrap();
        let (manifest, bytes, signature) = select_manifest(
            &catalog,
            "99.0.0",
            "portable",
            "linux-x86_64",
            include_str!("fixtures/public.key"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(bytes, include_bytes!("fixtures/manifest.json"));
        assert_eq!(signature, include_str!("fixtures/manifest.json.sig").trim());
        manifest
            .verify_payload_with_key(
                include_bytes!("fixtures/payload.txt"),
                include_str!("fixtures/public.key"),
            )
            .unwrap();
        assert!(
            select_manifest(&catalog, "99.0.0", "server", "linux-x86_64", PUBLIC_KEY)
                .unwrap()
                .is_none()
        );
        assert!(
            select_manifest(&catalog, "99.0.0", "portable", "linux-aarch64", PUBLIC_KEY)
                .unwrap()
                .is_none()
        );
        assert!(
            select_manifest(
                &catalog,
                "99.0.1",
                "portable",
                "linux-x86_64",
                include_str!("fixtures/public.key")
            )
            .is_err()
        );
        assert!(
            select_manifest(&catalog, "99.0.0", "portable", "linux-x86_64", PUBLIC_KEY).is_err()
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
                    "portable",
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
                "server",
                "linux-x86_64",
                include_str!("fixtures/public.key")
            )
            .is_err()
        );
    }

    #[test]
    fn native_configs_share_the_production_verification_key() {
        for config in [
            include_str!("../../../../desktop/tauri.conf.json"),
            include_str!("../../../../desktop/tauri.conf.headless.json"),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            assert_eq!(
                config["plugins"]["updater"]["pubkey"].as_str().unwrap(),
                PUBLIC_KEY.trim()
            );
        }
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
            archive: None,
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
