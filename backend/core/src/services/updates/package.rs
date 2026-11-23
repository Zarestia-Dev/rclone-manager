//! Installs a server package update (DEB, RPM, the Windows setup or the MSI)
//! with the installer its package format uses, as the user would by hand.
use super::manifest::ArtifactKind;
use crate::utils::types::updater::InstallOutcome;
use std::path::Path;

pub(super) fn install(kind: ArtifactKind, package: &Path) -> Result<InstallOutcome, String> {
    log::info!("Installing {kind} package {}", package.display());
    match kind {
        #[cfg(target_os = "linux")]
        ArtifactKind::Deb => install_as_root("dpkg", "-i", package),
        #[cfg(target_os = "linux")]
        ArtifactKind::Rpm => install_as_root("rpm", "-U", package),
        #[cfg(windows)]
        ArtifactKind::Nsis => run_setup(package),
        #[cfg(windows)]
        ArtifactKind::Msi => run_msi(package),
        _ => Err(crate::localized_error!(
            "backendErrors.updater.unsupportedInstallation"
        )),
    }
}

/// Runs the package tool as root in the first way that can ask for the password
/// (`policy::can_install_as_root`); the password never reaches this process. The
/// running build keeps running from the replaced file until it restarts.
#[cfg(target_os = "linux")]
fn install_as_root(tool: &str, flag: &str, package: &Path) -> Result<InstallOutcome, String> {
    use std::process::Command;
    let run = |mut command: Command| -> Result<(), (Option<i32>, String)> {
        let output = command
            .arg(tool)
            .arg(flag)
            .arg(package)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|error| (None, error.to_string()))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            Err((output.status.code(), stderr))
        }
    };
    let mut failure = None;
    if which::which("pkexec").is_ok() {
        match run(Command::new("pkexec")) {
            Ok(()) => return Ok(InstallOutcome::Restart),
            // 127: no polkit agent could ask (or authorization failed); 126 means the
            // user dismissed the dialog, which is no reason to ask again.
            Err((Some(127), error)) => {
                log::info!("pkexec could not authorize the package update: {error}");
                failure = Some(error);
            }
            Err((_, error)) => return Err(error),
        }
    }
    if which::which("sudo").is_ok()
        && let Some(askpass) = super::policy::askpass()
    {
        let mut command = Command::new("sudo");
        // -k: neither use nor leave a cached sudo login, so the password is asked for
        // this install only and nothing this process starts later runs as root.
        command.args(["-A", "-k"]);
        // Lives until sudo, which runs it, has finished.
        let _script;
        match askpass {
            super::policy::Askpass::Inherited => {}
            super::policy::Askpass::Program(program) => {
                command.env("SUDO_ASKPASS", program);
            }
            super::policy::Askpass::Dialog(dialog) => {
                let script = dialog_script(dialog).map_err(|error| error.to_string())?;
                command.env("SUDO_ASKPASS", &*script);
                _script = script;
            }
        }
        command.arg("--");
        return run(command)
            .map(|()| InstallOutcome::Restart)
            .map_err(|(_, error)| error);
    }
    if which::which("run0").is_ok() {
        return run(Command::new("run0"))
            .map(|()| InstallOutcome::Restart)
            .map_err(|(_, error)| error);
    }
    Err(failure
        .unwrap_or_else(|| crate::localized_error!("backendErrors.updater.noPrivilegePrompt")))
}

/// An askpass script for sudo: it shows the dialog with sudo's prompt, and the
/// dialog prints the password to sudo, never to this process. Removed when the
/// returned path is dropped.
#[cfg(target_os = "linux")]
fn dialog_script(dialog: &str) -> std::io::Result<tempfile::TempPath> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let arguments = if dialog == "zenity" {
        r#"--password --title "$1""#
    } else {
        r#"--password "$1""#
    };
    // The user's runtime folder, since /tmp can be mounted noexec.
    let directory = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .filter(|directory| directory.is_dir())
        .unwrap_or_else(std::env::temp_dir);
    let mut script = tempfile::Builder::new()
        .prefix("rclone-manager-askpass-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempfile_in(directory)?;
    writeln!(script, "#!/bin/sh\nexec {dialog} {arguments}")?;
    script.flush()?;
    Ok(script.into_temp_path())
}

/// The setup waits for this process to exit, replaces it in place and starts the
/// new version, like the Start menu entry does.
#[cfg(windows)]
fn run_setup(setup: &Path) -> Result<InstallOutcome, String> {
    std::process::Command::new(setup)
        .args(["/P", "/R"])
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(InstallOutcome::Exit)
}

/// An MSI installs for all users: msiexec asks for administrator approval and
/// replaces the files once this process has exited. The app then starts again as
/// the user, also when the update was cancelled.
#[cfg(windows)]
fn run_msi(msi: &Path) -> Result<InstallOutcome, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = format!(
        "Wait-Process -Id {} -ErrorAction SilentlyContinue; \
         Start-Process msiexec -Wait -ArgumentList '/i', ('\"' + $env:RCMAN_MSI + '\"'), '/passive'; \
         Start-Process $env:RCMAN_EXE",
        std::process::id()
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env("RCMAN_MSI", msi)
        .env(
            "RCMAN_EXE",
            std::env::current_exe().map_err(|e| e.to_string())?,
        )
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(InstallOutcome::Exit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_kinds_and_platforms_are_not_packages() {
        let path = Path::new("update.payload");
        for kind in [ArtifactKind::Server, ArtifactKind::Portable] {
            assert!(install(kind, path).is_err());
        }
        #[cfg(not(windows))]
        for kind in [ArtifactKind::Nsis, ArtifactKind::Msi] {
            assert!(install(kind, path).is_err());
        }
        #[cfg(not(target_os = "linux"))]
        assert!(install(ArtifactKind::Deb, path).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_askpass_script_hands_sudos_prompt_to_the_dialog() {
        use std::os::unix::fs::PermissionsExt;
        let bin = tempfile::tempdir().unwrap();
        for dialog in ["zenity", "kdialog"] {
            // Stands in for the dialog: prints what it was called with.
            let fake = bin.path().join(dialog);
            std::fs::write(&fake, "#!/bin/sh\nprintf '%s|' \"$@\"\n").unwrap();
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
            let script = dialog_script(dialog).unwrap();
            let output = std::process::Command::new(&*script)
                .arg("[sudo] password for user: ")
                .env("PATH", bin.path())
                .output()
                .unwrap();
            assert!(output.status.success());
            let expected = if dialog == "zenity" {
                "--password|--title|[sudo] password for user: |"
            } else {
                "--password|[sudo] password for user: |"
            };
            assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
            let path = script.to_path_buf();
            drop(script);
            assert!(!path.exists());
        }
    }
}
