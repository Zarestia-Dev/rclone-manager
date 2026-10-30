#[must_use]
pub fn get_build_type() -> Option<&'static str> {
    // Keep the existing command/wire values for frontend compatibility. This is
    // installation metadata, independent of the web-server runtime feature.
    installation_type(
        cfg!(feature = "flatpak"),
        cfg!(feature = "portable"),
        deployment_type().as_deref(),
    )
}

/// The deployment declared by `RCLONE_MANAGER_INSTALLATION_TYPE`, or a container when
/// the runtime marks one (Docker and Podman). Other runtimes may leave neither marker
/// and need the variable. An updated executable inside a container would be lost when
/// the container is recreated.
pub fn deployment_type() -> Option<String> {
    std::env::var("RCLONE_MANAGER_INSTALLATION_TYPE")
        .ok()
        .or_else(|| {
            if std::env::var_os("SNAP").is_some() {
                Some("snap".to_owned())
            } else if ["/.dockerenv", "/run/.containerenv"]
                .iter()
                .any(|marker| std::path::Path::new(marker).exists())
            {
                Some("container".to_owned())
            } else {
                None
            }
        })
}

fn installation_type(
    flatpak: bool,
    portable: bool,
    deployment: Option<&str>,
) -> Option<&'static str> {
    if flatpak {
        Some("flatpak")
    } else if portable {
        Some("portable")
    } else if let Some(dep) = deployment {
        match dep.trim().to_ascii_lowercase().as_str() {
            "docker" | "container" => Some("container"),
            "snap" => Some("snap"),
            _ => None,
        }
    } else {
        None
    }
}

#[must_use]
pub fn is_librclone() -> bool {
    cfg!(feature = "librclone")
}

#[cfg(test)]
mod installation_tests {
    use super::installation_type;

    #[test]
    fn docker_is_explicit_deployment_metadata() {
        assert_eq!(
            installation_type(false, false, Some("docker")),
            Some("container")
        );
        assert_eq!(
            installation_type(false, false, Some(" Docker ")),
            Some("container")
        );
        assert_eq!(
            installation_type(false, false, Some("CONTAINER")),
            Some("container")
        );
        assert_eq!(installation_type(false, false, Some("snap")), Some("snap"));
        assert_eq!(
            installation_type(false, false, Some(" SNAP ")),
            Some("snap")
        );
        for value in [
            None,
            Some(""),
            Some("  "),
            Some("web-server"),
            Some("unknown"),
        ] {
            assert_eq!(installation_type(false, false, value), None);
        }
    }

    #[test]
    fn packaging_features_take_precedence() {
        assert_eq!(
            installation_type(true, true, Some("docker")),
            Some("flatpak")
        );
        assert_eq!(
            installation_type(false, true, Some("docker")),
            Some("portable")
        );
        assert_eq!(installation_type(true, false, None), Some("flatpak"));
        assert_eq!(installation_type(false, true, None), Some("portable"));
    }
}
