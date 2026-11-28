//! Replaces a portable, server or AppImage build in place with a verified artifact,
//! as `rclone selfupdate` does. The host's ordinary restart then starts the new
//! file from the same path.
use super::manifest::{ArtifactKind, Manifest};
use crate::utils::app::paths::{app_bundle_path, installation_directory};
use crate::utils::types::updater::InstallOutcome;
use std::path::{Path, PathBuf};

/// The file an update replaces. An AppImage runs its executable from a read-only
/// mount, so the image itself, named by `$APPIMAGE`, is what gets replaced.
fn installed_executable(kind: ArtifactKind) -> std::io::Result<PathBuf> {
    image_or_executable(kind, std::env::var_os("APPIMAGE"))
}

fn image_or_executable(
    kind: ArtifactKind,
    appimage: Option<std::ffi::OsString>,
) -> std::io::Result<PathBuf> {
    match kind {
        ArtifactKind::Appimage => PathBuf::from(appimage.ok_or_else(|| {
            std::io::Error::other(crate::localized_error!(
                "backendErrors.updater.unsupportedInstallation"
            ))
        })?)
        .canonicalize(),
        _ => std::env::current_exe()?.canonicalize(),
    }
}

/// Puts the verified `payload` where the running build was started from. The
/// running process keeps its own copy until the restart.
pub(super) fn install(manifest: &Manifest, payload: &[u8]) -> Result<InstallOutcome, String> {
    let target = installed_executable(manifest.kind).map_err(|e| e.to_string())?;
    let writable = super::policy::writable_binary(&target);
    match manifest.bundle_root() {
        // The desktop app is installed for all users: where its folder is not the
        // user's, macOS asks for the administrator password, as it does for any
        // installer.
        #[cfg(target_os = "macos")]
        Some(root) if manifest.kind == ArtifactKind::App && writable.is_err() => {
            replace_bundle_as_administrator(&target, payload, root)?
        }
        Some(root) => {
            writable.map_err(|e| e.to_string())?;
            replace_bundle(&target, payload, root)?
        }
        None => {
            writable.map_err(|e| e.to_string())?;
            replace_file(&target, payload).map_err(|e| e.to_string())?
        }
    }
    log::info!(
        "Installed update {} at {}",
        manifest.version,
        target.display()
    );
    Ok(InstallOutcome::Restart)
}

/// Writes the new file beside the old one and renames it over it. Windows cannot
/// replace a running executable, but it can rename it: it is kept as
/// `<name>.old.exe` and removed on the next start.
fn replace_file(target: &Path, payload: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let directory = target
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing installation directory"))?;
    let mut file = tempfile::Builder::new()
        .prefix(".rcman-update-")
        .tempfile_in(directory)?;
    file.write_all(payload)?;
    file.as_file()
        .set_permissions(std::fs::metadata(target)?.permissions())?;
    file.as_file().sync_all()?;
    #[cfg(windows)]
    {
        let old = old_executable(target);
        remove_if_present(&old)?;
        std::fs::rename(target, &old)?;
        if let Err(error) = file.persist(target) {
            let _ = std::fs::rename(&old, target);
            return Err(error.error);
        }
    }
    #[cfg(not(windows))]
    file.persist(target).map_err(|error| error.error)?;
    Ok(())
}

/// Unpacks the new `.app` bundle into `directory`. Returns the installed bundle
/// and the unpacked one.
fn stage_bundle<'a>(
    target: &'a Path,
    payload: &[u8],
    root: &str,
    directory: &Path,
) -> Result<(&'a Path, PathBuf), String> {
    let bundle = app_bundle_path(target)
        .ok_or_else(|| crate::localized_error!("backendErrors.updater.invalidBundle"))?;
    let candidate = directory.join("candidate");
    crate::utils::archive::extract_zip_bundle(payload, &candidate, root)?;
    let candidate = candidate.join(root);
    let binary = candidate.join(target.strip_prefix(bundle).map_err(|e| e.to_string())?);
    std::fs::set_permissions(
        &binary,
        std::fs::metadata(target)
            .map_err(|e| e.to_string())?
            .permissions(),
    )
    .map_err(|e| e.to_string())?;
    Ok((bundle, candidate))
}

/// A macOS app replaces its whole `.app` bundle, whose signature covers every
/// file in it.
fn replace_bundle(target: &Path, payload: &[u8], root: &str) -> Result<(), String> {
    let directory = tempfile::Builder::new()
        .prefix(".rcman-update-")
        .tempdir_in(installation_directory(target).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let (bundle, candidate) = stage_bundle(target, payload, root, directory.path())?;
    // The old bundle goes with the temporary directory; its running files stay
    // readable until the restart.
    let previous = directory.path().join("previous.app");
    std::fs::rename(bundle, &previous).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&candidate, bundle) {
        let _ = std::fs::rename(&previous, bundle);
        return Err(error.to_string());
    }
    Ok(())
}

/// Unpacks the new bundle in the user's temporary folder, where no rights are
/// needed, and swaps it in as root. The old bundle is put back when the copy fails.
/// The new bundle keeps the owner the copy gives it, so the next update asks again.
#[cfg(target_os = "macos")]
fn replace_bundle_as_administrator(
    target: &Path,
    payload: &[u8],
    root: &str,
) -> Result<(), String> {
    let directory = tempfile::Builder::new()
        .prefix("rcman-update-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let (bundle, candidate) = stage_bundle(target, payload, root, directory.path())?;
    let script = bundle_swap_script(bundle, &candidate);
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            &crate::utils::process::command::as_administrator(&script),
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(crate::utils::process::command::osascript_error(
            &String::from_utf8_lossy(&output.stderr),
        ))
    }
}

/// The shell script that replaces `bundle` with `candidate`: the old bundle stays
/// aside until the copy has worked and is put back when it has not.
#[cfg(any(target_os = "macos", test))]
fn bundle_swap_script(bundle: &Path, candidate: &Path) -> String {
    use crate::utils::process::command::shell_quote;
    let bundle = bundle.to_string_lossy();
    let previous = shell_quote(&format!("{bundle}.rcman-old"));
    let (bundle, candidate) = (
        shell_quote(&bundle),
        shell_quote(&candidate.to_string_lossy()),
    );
    format!(
        "rm -rf {previous} && mv {bundle} {previous} && if ditto {candidate} {bundle}; \
         then rm -rf {previous}; else rm -rf {bundle}; mv {previous} {bundle}; false; fi"
    )
}

#[cfg(windows)]
fn old_executable(target: &Path) -> PathBuf {
    target.with_extension("old.exe")
}

#[cfg(windows)]
fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Versions before 0.3.7-beta.3 start an update as the child of a supervisor that
/// puts the old version back unless the new one confirms its startup within 90
/// seconds, through the directory and token in these variables.
const LEGACY_DIRECTORY_ENV: &str = "RCMAN_UPDATE_HEALTH_DIRECTORY";
const LEGACY_TOKEN_ENV: &str = "RCMAN_UPDATE_HEALTH_TOKEN";
const LEGACY_ASSIGNMENT_ENV: &str = "RCMAN_UPDATE_WAIT_FOR_ASSIGNMENT";

/// Runs first in `main`, before any thread starts: confirms the startup to an
/// older version's supervisor, so it keeps this update, and removes the Windows
/// executable an update left behind.
pub fn on_startup() {
    let directory = std::env::var_os(LEGACY_DIRECTORY_ENV);
    let token = std::env::var(LEGACY_TOKEN_ENV);
    // Neither rclone nor a restarted build may inherit them.
    unsafe {
        std::env::remove_var(LEGACY_DIRECTORY_ENV);
        std::env::remove_var(LEGACY_TOKEN_ENV);
        std::env::remove_var(LEGACY_ASSIGNMENT_ENV);
    }
    if let (Some(directory), Ok(token)) = (directory, token)
        && let Err(error) = confirm_legacy_startup(Path::new(&directory), &token)
    {
        eprintln!("Could not confirm the update to the previous version: {error}");
    }
    #[cfg(windows)]
    if let Ok(executable) = std::env::current_exe() {
        let _ = remove_if_present(&old_executable(&executable));
    }
}

/// The receipt the old supervisor reads: `ready.json` with its token and the
/// version it installed.
fn confirm_legacy_startup(directory: &Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    let receipt = serde_json::json!({ "token": token, "version": env!("CARGO_PKG_VERSION") });
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&serde_json::to_vec(&receipt)?)?;
    file.as_file().sync_all()?;
    file.persist(directory.join("ready.json"))
        .map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the swap with a shell function standing in for macOS's `ditto`.
    #[cfg(unix)]
    fn swap(bundle: &Path, candidate: &Path, ditto: &str) -> bool {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "ditto() {{ {ditto}; }}; {}",
                bundle_swap_script(bundle, candidate)
            ))
            .status()
            .unwrap()
            .success()
    }

    #[cfg(unix)]
    #[test]
    fn a_swapped_bundle_replaces_the_old_one_and_leaves_nothing_behind() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("It's Old.app");
        let candidate = root.path().join("new dir").join("New.app");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::create_dir_all(&candidate).unwrap();
        std::fs::write(bundle.join("old"), b"old").unwrap();
        std::fs::write(candidate.join("new"), b"new").unwrap();
        // A copy left by an update that was interrupted earlier.
        let leftover = root.path().join("It's Old.app.rcman-old");
        std::fs::create_dir_all(&leftover).unwrap();

        assert!(swap(&bundle, &candidate, r#"cp -R "$1" "$2""#));
        assert!(bundle.join("new").exists() && !bundle.join("old").exists());
        assert!(!leftover.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_puts_the_old_bundle_back() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("Old.app");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("old"), b"old").unwrap();
        let candidate = root.path().join("New.app");
        std::fs::create_dir_all(&candidate).unwrap();

        // The copy leaves a half-written bundle, then fails.
        assert!(!swap(&bundle, &candidate, r#"mkdir "$2" && false"#));
        assert!(bundle.join("old").exists());
        assert!(!root.path().join("Old.app.rcman-old").exists());
    }

    #[test]
    fn replacement_keeps_permissions_and_the_files_beside_it() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("App with ' spaces");
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(root.path().join("settings.json"), b"private config").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        }
        let permissions = std::fs::metadata(&target).unwrap().permissions();
        replace_file(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions(),
            permissions
        );
        assert_eq!(
            std::fs::read(root.path().join("settings.json")).unwrap(),
            b"private config"
        );
        // Only the replaced file and its neighbour remain: no temporary file.
        let mut names: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        #[cfg(windows)]
        assert_eq!(
            names,
            [
                "App with ' spaces",
                "App with ' spaces.old.exe",
                "settings.json"
            ]
        );
        #[cfg(not(windows))]
        assert_eq!(names, ["App with ' spaces", "settings.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_running_executable_keeps_its_own_copy() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("app");
        std::fs::write(&target, b"old").unwrap();
        let running = std::fs::File::open(&target).unwrap();
        replace_file(&target, b"new").unwrap();
        let mut old = String::new();
        std::io::Read::read_to_string(&mut &running, &mut old).unwrap();
        assert_eq!(old, "old");
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn app_bundle_replacement_keeps_the_settings_beside_it() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("Renamed.app");
        let target = bundle.join("Contents/MacOS/rclone-manager");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"old executable").unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), b"old bundle metadata").unwrap();
        std::fs::write(bundle.join("Contents/stale"), b"removed").unwrap();
        std::fs::create_dir(root.path().join("config")).unwrap();
        let settings = root.path().join("config/settings.json");
        std::fs::write(&settings, b"private user settings").unwrap();
        let manifest = super::super::manifest::test_portable_manifest("macos-aarch64");
        let payload = include_bytes!("fixtures/portable-macos-aarch64-99.0.0.zip");
        replace_bundle(&target, payload, manifest.bundle_root().unwrap()).unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            include_bytes!("fixtures/payload.txt")
        );
        assert_eq!(
            std::fs::read(bundle.join("Contents/Info.plist")).unwrap(),
            b"<plist/>"
        );
        assert_eq!(
            std::fs::read(bundle.join("Contents/_CodeSignature/CodeResources")).unwrap(),
            b"fixture signature resource"
        );
        assert!(!bundle.join("Contents/stale").exists());
        assert_eq!(std::fs::read(&settings).unwrap(), b"private user settings");
        // The old bundle went with the temporary directory.
        let names: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn an_appimage_replaces_its_image_and_other_builds_their_executable() {
        let root = tempfile::tempdir().unwrap();
        let image = root.path().join("RClone Manager.AppImage");
        std::fs::write(&image, b"image").unwrap();
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let relative = root.path().join(".").join("RClone Manager.AppImage");
        assert_eq!(
            image_or_executable(ArtifactKind::Appimage, Some(relative.into())).unwrap(),
            image.canonicalize().unwrap()
        );
        // Without `$APPIMAGE` the mounted executable must never become the target.
        assert!(image_or_executable(ArtifactKind::Appimage, None).is_err());
        // Other builds ignore an `$APPIMAGE` inherited from another application.
        for kind in [ArtifactKind::Portable, ArtifactKind::Server] {
            assert_eq!(
                image_or_executable(kind, Some(image.clone().into())).unwrap(),
                executable
            );
        }
    }

    #[test]
    fn the_receipt_matches_what_older_supervisors_read() {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Receipt {
            token: String,
            version: String,
        }
        let directory = tempfile::tempdir().unwrap();
        confirm_legacy_startup(directory.path(), "attempt").unwrap();
        let receipt: Receipt =
            serde_json::from_slice(&std::fs::read(directory.path().join("ready.json")).unwrap())
                .unwrap();
        assert_eq!(receipt.token, "attempt");
        assert_eq!(receipt.version, env!("CARGO_PKG_VERSION"));
    }
}
