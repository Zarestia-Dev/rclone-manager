//! Upstream package availability for installations updated by external tools.
use super::policy::InstallationKind;
use crate::utils::github_client::Release;

pub(super) fn external_asset(
    release: &Release,
    installation: InstallationKind,
    os: &str,
    arch: &str,
) -> Option<String> {
    if os != "linux" {
        return None;
    }
    // A release tag only carries its own product's packages, so the product
    // name is not part of the match and renaming it cannot hide an update.
    let version = super::clean_app_version(&release.tag_name);
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
                asset.name.ends_with(&format!("_{version}_{deb_arch}.deb"))
            }
            InstallationKind::Rpm => asset
                .name
                .strip_suffix(&format!(".{arch}.rpm"))
                .and_then(|stem| stem.rsplit_once('-'))
                .is_some_and(|(name_version, _release)| {
                    name_version.ends_with(&format!("-{version}"))
                }),
            _ => false,
        })
        .map(|asset| asset.name.clone())
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
                    browser_download_url: String::new(),
                    api_url: None,
                })
                .collect(),
            prerelease: false,
            draft: false,
            body: None,
            published_at: None,
            html_url: String::new(),
        }
    }

    #[test]
    fn packages_must_match_product_version_architecture_and_format() {
        for (tag, product) in [
            ("v1.2.3-beta.1", "RClone.Manager"),
            ("headless-v1.2.3-beta.1", "RClone.Manager.Headless"),
        ] {
            for (arch, deb_arch) in [("x86_64", "amd64"), ("aarch64", "arm64")] {
                let deb = format!("{product}_1.2.3-beta.1_{deb_arch}.deb");
                let rpm = format!("{product}-1.2.3-beta.1-1.{arch}.rpm");
                for kind in [
                    InstallationKind::Flatpak,
                    InstallationKind::Pacman,
                    InstallationKind::Deb,
                ] {
                    assert_eq!(
                        external_asset(&release(tag, &[&deb]), kind, "linux", arch),
                        Some(deb.clone())
                    );
                    for wrong in [
                        format!("{product}_1.2.2_{deb_arch}.deb"),
                        format!("{product}_1.2.3-beta.1_other.deb"),
                        format!("{product}_1.2.3-beta.1_{deb_arch}.rpm"),
                        rpm.clone(),
                    ] {
                        assert!(
                            external_asset(&release(tag, &[&wrong]), kind, "linux", arch).is_none()
                        );
                    }
                }
                assert_eq!(
                    external_asset(&release(tag, &[&rpm]), InstallationKind::Rpm, "linux", arch),
                    Some(rpm)
                );
                assert!(
                    external_asset(&release(tag, &[&deb]), InstallationKind::Rpm, "linux", arch)
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn packages_are_found_whatever_the_product_is_called() {
        for product in ["Renamed", "RClone.Manager.Pro", "A-B"] {
            let deb = format!("{product}_1.2.3_amd64.deb");
            let rpm = format!("{product}-1.2.3-1.x86_64.rpm");
            assert_eq!(
                external_asset(
                    &release("v1.2.3", &[&deb]),
                    InstallationKind::Deb,
                    "linux",
                    "x86_64"
                ),
                Some(deb)
            );
            assert_eq!(
                external_asset(
                    &release("v1.2.3", &[&rpm]),
                    InstallationKind::Rpm,
                    "linux",
                    "x86_64"
                ),
                Some(rpm)
            );
        }
        for wrong in [
            "Renamed-1.2.30-1.x86_64.rpm",
            "Renamed-1.2.3-beta.1-1.x86_64.rpm",
            "Renamed-1.2.3.x86_64.rpm",
            "Renamed-1.2.3-1.aarch64.rpm",
        ] {
            assert!(
                external_asset(
                    &release("v1.2.3", &[wrong]),
                    InstallationKind::Rpm,
                    "linux",
                    "x86_64"
                )
                .is_none(),
                "{wrong}"
            );
        }
    }

    #[test]
    fn containers_require_their_server_architecture_and_other_installations_do_not_guess() {
        let release = release("headless-v1.2.3", &["server-linux-aarch64-1.2.3.zip"]);
        assert!(
            external_asset(&release, InstallationKind::Container, "linux", "aarch64").is_some()
        );
        for (kind, os, arch) in [
            (InstallationKind::Container, "linux", "x86_64"),
            (InstallationKind::Container, "windows", "aarch64"),
            (InstallationKind::Container, "linux", "arm"),
            (InstallationKind::Unknown, "linux", "aarch64"),
            (InstallationKind::Portable, "linux", "aarch64"),
        ] {
            assert!(external_asset(&release, kind, os, arch).is_none());
        }
        assert!(
            external_asset(
                &self::release("v1.2.3", &[]),
                InstallationKind::Deb,
                "linux",
                "x86_64"
            )
            .is_none()
        );
    }
}
