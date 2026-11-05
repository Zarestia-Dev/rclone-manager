/// The deployment declared by `RCLONE_MANAGER_INSTALLATION_TYPE`, or a container when
/// the runtime marks one (Docker and Podman). Other runtimes may leave neither marker
/// and need the variable. An updated executable inside a container would be lost when
/// the container is recreated.
pub fn deployment_type() -> Option<String> {
    std::env::var("RCLONE_MANAGER_INSTALLATION_TYPE")
        .ok()
        .or_else(|| {
            ["/.dockerenv", "/run/.containerenv"]
                .iter()
                .any(|marker| std::path::Path::new(marker).exists())
                .then(|| "container".to_owned())
        })
}

#[must_use]
pub fn is_librclone() -> bool {
    cfg!(feature = "librclone")
}
