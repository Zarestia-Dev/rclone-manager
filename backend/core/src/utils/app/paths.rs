use std::path::Path;

/// Resolve the app containing a standard macOS bundle executable.
pub fn app_bundle_path(executable: &Path) -> Option<&Path> {
    let directory = executable.parent()?;
    let contents = directory.parent()?;
    let bundle = contents.parent()?;
    (directory.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

/// Portable data and update staging live beside the executable or its app bundle.
pub fn installation_directory(executable: &Path) -> std::io::Result<&Path> {
    app_bundle_path(executable)
        .unwrap_or(executable)
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing installation directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installation_directory_handles_bundles_and_standalone_executables() {
        let bundle = Path::new("/portable/Renamed.app/Contents/MacOS/rclone-manager");
        assert_eq!(
            app_bundle_path(bundle),
            Some(Path::new("/portable/Renamed.app"))
        );
        assert_eq!(
            installation_directory(bundle).unwrap(),
            Path::new("/portable")
        );
        for executable in [
            "/portable/RCloneManager",
            "/portable/RCloneManager.exe",
            "/portable/Contents/MacOS/rclone-manager",
        ] {
            let executable = Path::new(executable);
            assert_eq!(app_bundle_path(executable), None);
            assert_eq!(
                installation_directory(executable).unwrap(),
                executable.parent().unwrap()
            );
        }
        assert!(installation_directory(Path::new("/")).is_err());
    }
}
