#[must_use]
pub fn get_build_type() -> Option<&'static str> {
    // Keep the existing command/wire values for frontend compatibility. This is
    // installation metadata, independent of the web-server runtime feature.
    installation_type(
        cfg!(feature = "flatpak"),
        cfg!(feature = "portable"),
        std::env::var("RCLONE_MANAGER_INSTALLATION_TYPE")
            .ok()
            .as_deref(),
    )
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
    } else if deployment.is_some_and(|value| value.trim().eq_ignore_ascii_case("docker")) {
        Some("container")
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
