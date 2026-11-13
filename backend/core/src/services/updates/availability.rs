//! Upstream package availability for installations updated by external tools.
use super::policy::InstallationKind;
use crate::utils::github_client::Release;

/// The release asset an external package is built from, if this release has one.
/// `product_name` is the Tauri product name; bundles replace its spaces with dots.
pub(super) fn external_asset(
    release: &Release,
    installation: InstallationKind,
    product_name: &str,
    os: &str,
    arch: &str,
) -> Option<String> {
    if os != "linux" {
        return None;
    }
    let version = super::clean_app_version(&release.tag_name);
    let product = product_name.replace(' ', ".");
    let deb_arch = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    release
        .assets
        .iter()
        .find(|asset| match installation {
            InstallationKind::Container => {
                asset.name == format!("server-linux-{arch}-{version}.zip")
            }
            InstallationKind::Flatpak | InstallationKind::Pacman | InstallationKind::Deb => {
                asset.name == format!("{product}_{version}_{deb_arch}.deb")
            }
            InstallationKind::Rpm => {
                asset.name.starts_with(&format!("{product}-{version}-"))
                    && asset.name.ends_with(&format!(".{arch}.rpm"))
            }
            _ => false,
        })
        .map(|asset| asset.name.clone())
}

/// The upstream version the AUR publishes for `package`, or `None` when the AUR
/// does not know it.
pub(super) async fn aur_version(package: &str) -> Result<Option<String>, String> {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        crate::utils::github_client::detect_stalls(reqwest::Client::builder())
            .user_agent(concat!("rclone-manager/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    });
    let url = reqwest::Url::parse_with_params(
        "https://aur.archlinux.org/rpc/v5/info",
        [("arg[]", package)],
    )
    .map_err(|e| e.to_string())?;
    let body = CLIENT
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    aur_pkgver(&body, package)
}

/// Reads `pkgver` from an AUR info response: `Version` is `[epoch:]pkgver-pkgrel`.
fn aur_pkgver(body: &[u8], package: &str) -> Result<Option<String>, String> {
    let response: serde_json::Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let results = response["results"]
        .as_array()
        .ok_or("Unexpected AUR response")?;
    Ok(results
        .iter()
        .find(|entry| entry["Name"] == package)
        .and_then(|entry| entry["Version"].as_str())
        .map(|version| {
            let version = version.split_once(':').map_or(version, |(_, rest)| rest);
            version
                .rsplit_once('-')
                .map_or(version, |(pkgver, _)| pkgver)
                .to_owned()
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::github_client::Asset;

    fn release(tag: &str, names: &[&str]) -> Release {
        Release {
            tag_name: tag.into(),
            assets: names
                .iter()
                .map(|name| Asset {
                    name: (*name).into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn packages_must_match_product_version_architecture_and_format() {
        for (tag, product_name, product) in [
            ("v1.2.3-beta.1", "RClone Manager", "RClone.Manager"),
            (
                "headless-v1.2.3-beta.1",
                "RClone Manager Headless",
                "RClone.Manager.Headless",
            ),
        ] {
            let asset = |release: &Release, kind, arch| {
                external_asset(release, kind, product_name, "linux", arch)
            };
            for (arch, deb_arch) in [("x86_64", "amd64"), ("aarch64", "arm64")] {
                let deb = format!("{product}_1.2.3-beta.1_{deb_arch}.deb");
                let rpm = format!("{product}-1.2.3-beta.1-1.{arch}.rpm");
                for kind in [
                    InstallationKind::Flatpak,
                    InstallationKind::Pacman,
                    InstallationKind::Deb,
                ] {
                    assert_eq!(asset(&release(tag, &[&deb]), kind, arch), Some(deb.clone()));
                    for wrong in [
                        format!("{product}_1.2.2_{deb_arch}.deb"),
                        format!("{product}_1.2.3-beta.1_other.deb"),
                        format!("Other_1.2.3-beta.1_{deb_arch}.deb"),
                        rpm.clone(),
                    ] {
                        assert!(asset(&release(tag, &[&wrong]), kind, arch).is_none());
                    }
                }
                assert_eq!(
                    asset(&release(tag, &[&rpm]), InstallationKind::Rpm, arch),
                    Some(rpm)
                );
                assert!(asset(&release(tag, &[&deb]), InstallationKind::Rpm, arch).is_none());
            }
        }
    }

    #[test]
    fn containers_require_their_server_architecture_and_other_installations_do_not_guess() {
        let product = "RClone Manager Headless";
        let release = release("headless-v1.2.3", &["server-linux-aarch64-1.2.3.zip"]);
        assert!(
            external_asset(
                &release,
                InstallationKind::Container,
                product,
                "linux",
                "aarch64"
            )
            .is_some()
        );
        for (kind, os, arch) in [
            (InstallationKind::Container, "linux", "x86_64"),
            (InstallationKind::Container, "windows", "aarch64"),
            (InstallationKind::Container, "linux", "arm"),
            (InstallationKind::Unknown, "linux", "aarch64"),
            (InstallationKind::Portable, "linux", "aarch64"),
        ] {
            assert!(external_asset(&release, kind, product, os, arch).is_none());
        }
        assert!(
            external_asset(
                &self::release("v1.2.3", &[]),
                InstallationKind::Deb,
                "RClone Manager",
                "linux",
                "x86_64"
            )
            .is_none()
        );
    }

    #[test]
    fn aur_versions_drop_epoch_and_pkgrel_and_ignore_other_packages() {
        let body = |version: &str| {
            format!(
                r#"{{"resultcount":2,"type":"multiinfo","version":5,"results":[
                    {{"Name":"rclone-manager-git","Version":"r900.abc-1"}},
                    {{"Name":"rclone-manager","Version":"{version}"}}]}}"#
            )
        };
        for (version, expected) in [
            ("0.3.5-1", "0.3.5"),
            ("0.3.5-12", "0.3.5"),
            ("2:0.3.5-1", "0.3.5"),
        ] {
            assert_eq!(
                aur_pkgver(body(version).as_bytes(), "rclone-manager")
                    .unwrap()
                    .as_deref(),
                Some(expected)
            );
        }
        assert_eq!(
            aur_pkgver(br#"{"resultcount":0,"results":[]}"#, "rclone-manager").unwrap(),
            None
        );
        for invalid in [&b"not json"[..], br#"{"error":"Incorrect request type"}"#] {
            assert!(aur_pkgver(invalid, "rclone-manager").is_err());
        }
    }
}
