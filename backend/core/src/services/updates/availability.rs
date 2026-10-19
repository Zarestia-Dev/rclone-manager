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
    let version = super::clean_app_version(&release.tag_name);
    let product = if release.tag_name.starts_with("headless-v") {
        "RClone.Manager.Headless"
    } else {
        "RClone.Manager"
    };
    let deb_arch = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    release
        .assets
        .iter()
        .find(|asset| match installation {
            InstallationKind::Container => asset.name == format!("server-linux-{arch}-{version}"),
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
                        format!("Other_1.2.3-beta.1_{deb_arch}.deb"),
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
    fn containers_require_their_server_architecture_and_other_installations_do_not_guess() {
        let release = release("headless-v1.2.3", &["server-linux-aarch64-1.2.3"]);
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
