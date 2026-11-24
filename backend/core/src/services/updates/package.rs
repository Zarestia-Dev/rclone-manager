//! Installs a server package update (DEB, RPM, Arch package, the Windows setup or
//! the MSI) with the installer its package format uses, as the user would by hand.
use super::manifest::ArtifactKind;
use super::policy::InstallationKind;
use crate::utils::types::updater::InstallOutcome;
#[cfg(any(target_os = "linux", windows))]
use std::path::Path;

/// Installs `payload`, the package's verified bytes.
pub(super) fn install(
    installation: InstallationKind,
    payload: &[u8],
) -> Result<InstallOutcome, String> {
    let kind = super::signed::artifact_kind(installation);
    log::info!("Installing {kind} package ({} bytes)", payload.len());
    match kind {
        #[cfg(target_os = "linux")]
        ArtifactKind::Deb | ArtifactKind::Rpm | ArtifactKind::Pacman => {
            let package = write_package(kind, payload).map_err(|e| e.to_string())?;
            install_as_root(installation, &package)
        }
        #[cfg(windows)]
        ArtifactKind::Nsis | ArtifactKind::Msi => {
            // The script that runs the installer removes the file afterwards.
            let package = write_package(kind, payload)
                .and_then(|package| package.keep().map_err(|e| e.error))
                .map_err(|e| e.to_string())?;
            run_installer(kind, &package)
        }
        _ => Err(crate::localized_error!(
            "backendErrors.updater.unsupportedInstallation"
        )),
    }
}

/// Writes the verified bytes to a new file that only this user can open, so the
/// installer runs what was verified and not the download cache, which may have
/// changed since. Removed when the returned path is dropped.
#[cfg(any(target_os = "linux", windows))]
fn write_package(kind: ArtifactKind, payload: &[u8]) -> std::io::Result<tempfile::TempPath> {
    use std::io::Write;
    let mut file = tempfile::Builder::new()
        .prefix("rclone-manager-update-")
        .suffix(&format!(".{}", kind.extension()))
        .tempfile()?;
    file.write_all(payload)?;
    file.as_file().sync_all()?;
    // Closed, so that the installer can open it on Windows.
    Ok(file.into_temp_path())
}

/// Runs the package tool as root through pkexec, or `sudo -A` with a password
/// dialog where no polkit agent can ask (`policy::can_install_as_root`); the
/// password never reaches this process. The running build keeps running from the
/// replaced file until it restarts.
#[cfg(target_os = "linux")]
fn install_as_root(
    installation: InstallationKind,
    package: &Path,
) -> Result<InstallOutcome, String> {
    use super::policy::system_program;
    use std::process::Command;
    let (tool, flags, _) = super::policy::linux_installer(installation);
    let tool = system_program(tool)
        .ok_or_else(|| crate::localized_error!("backendErrors.updater.unsupportedInstallation"))?;
    let run = |mut command: Command| -> Result<(), (Option<i32>, String)> {
        let output = command
            .arg(&tool)
            .args(flags)
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
    if let Some(pkexec) = system_program("pkexec") {
        match run(Command::new(pkexec)) {
            Ok(()) => return Ok(InstallOutcome::Restart),
            // 127: no polkit agent could ask (or authorization failed); 126 means the
            // user dismissed the dialog, which is no reason to ask again.
            Err((Some(127), error)) => {
                log::warn!("pkexec could not authorize the package update: {error}");
            }
            Err((_, error)) => return Err(error),
        }
    }
    if let Some(sudo) = system_program("sudo")
        && let Some(dialog) = super::policy::password_dialog()
    {
        let script = dialog_script(dialog).map_err(|error| error.to_string())?;
        let mut command = Command::new(sudo);
        // -k: neither use nor leave a cached sudo login, so the password is asked for
        // this install only and nothing this process starts later runs as root.
        command
            .args(["-A", "-k"])
            .env("SUDO_ASKPASS", &*script)
            .arg("--");
        return run(command)
            .map(|()| InstallOutcome::Restart)
            .map_err(|(_, error)| error);
    }
    Err(super::policy::no_privilege_prompt(installation))
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

/// Carries the launch arguments to the PowerShell script that restarts the app.
/// They may hold secrets such as `--pass`, so they travel in its private
/// environment, never on its command line or on disk.
#[cfg(windows)]
const LAUNCH_ARGS_ENV: &str = "RCMAN_LAUNCH_ARGS";
#[cfg(windows)]
const INSTALLER_ENV: &str = "RCMAN_INSTALLER";
#[cfg(windows)]
const EXECUTABLE_ENV: &str = "RCMAN_EXE";
/// Windows limits a command line to 32,767 characters.
#[cfg(any(windows, test))]
const MAX_COMMAND_LINE: usize = 32_000;

/// The setup (for the current user) or the MSI (for all users: msiexec asks for
/// administrator approval) replaces the files once this process has exited. The
/// app then starts again as the user with the arguments it was started with, also
/// when the update was cancelled.
#[cfg(windows)]
fn run_installer(kind: ArtifactKind, installer: &Path) -> Result<InstallOutcome, String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let arguments: Vec<Vec<u16>> = std::env::args_os()
        .skip(1)
        .map(|argument| argument.encode_wide().collect())
        .collect();
    let command_line = quote_command_line(&arguments)?;
    // /P without /R: the script starts the app itself, with its arguments. The
    // system's own msiexec and PowerShell, never a program of the same name in the
    // app's folder, which the setup installs where the user can write.
    let install = match kind {
        ArtifactKind::Msi => {
            "Start-Process \"$env:SystemRoot\\System32\\msiexec.exe\" -Wait -ArgumentList ('/i \"' + $installer + '\" /passive')"
        }
        _ => "Start-Process $installer -Wait -ArgumentList '/P'",
    };
    // The variables are read and removed first, so neither the installer nor the
    // restarted app inherits them.
    let script = format!(
        "$installer = $env:{INSTALLER_ENV}; $exe = $env:{EXECUTABLE_ENV}; \
         $arguments = $env:{LAUNCH_ARGS_ENV}; \
         Remove-Item Env:{INSTALLER_ENV}, Env:{EXECUTABLE_ENV}, Env:{LAUNCH_ARGS_ENV} -ErrorAction SilentlyContinue; \
         Wait-Process -Id {} -ErrorAction SilentlyContinue; \
         {install}; \
         Remove-Item -LiteralPath $installer -ErrorAction SilentlyContinue; \
         if ($arguments) {{ Start-Process $exe -ArgumentList $arguments }} else {{ Start-Process $exe }}",
        std::process::id()
    );
    let powershell =
        std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(|| {
            crate::localized_error!("backendErrors.updater.unsupportedInstallation")
        })?)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    std::process::Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env(INSTALLER_ENV, installer)
        .env(
            EXECUTABLE_ENV,
            std::env::current_exe().map_err(|e| e.to_string())?,
        )
        .env(
            LAUNCH_ARGS_ENV,
            std::ffi::OsString::from_wide(&command_line),
        )
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(InstallOutcome::Exit)
}

/// Joins arguments into a Windows command line that `CommandLineToArgvW` (and
/// Rust's `std::env::args`) splits back into the same arguments.
#[cfg(any(windows, test))]
fn quote_command_line(arguments: &[Vec<u16>]) -> Result<Vec<u16>, String> {
    const SPACE: u16 = b' ' as u16;
    const TAB: u16 = b'\t' as u16;
    const QUOTE: u16 = b'"' as u16;
    const BACKSLASH: u16 = b'\\' as u16;
    let mut line = Vec::new();
    for argument in arguments {
        if !line.is_empty() {
            line.push(SPACE);
        }
        if !argument.is_empty() && !argument.iter().any(|c| [SPACE, TAB, QUOTE].contains(c)) {
            line.extend_from_slice(argument);
            continue;
        }
        line.push(QUOTE);
        let mut backslashes = 0;
        for &c in argument {
            if c == BACKSLASH {
                backslashes += 1;
            } else {
                // Backslashes before a quote are escaped, and so is the quote.
                if c == QUOTE {
                    line.extend(std::iter::repeat_n(BACKSLASH, backslashes + 1));
                }
                backslashes = 0;
            }
            line.push(c);
        }
        // So that the closing quote is not escaped.
        line.extend(std::iter::repeat_n(BACKSLASH, backslashes));
        line.push(QUOTE);
    }
    if line.len() > MAX_COMMAND_LINE {
        return Err(crate::localized_error!(
            "backendErrors.updater.argumentsTooLong"
        ));
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_kinds_and_platforms_are_not_packages() {
        let payload = b"payload";
        for kind in [InstallationKind::Server, InstallationKind::Portable] {
            assert!(install(kind, payload).is_err());
        }
        #[cfg(not(windows))]
        for kind in [InstallationKind::Nsis, InstallationKind::Msi] {
            assert!(install(kind, payload).is_err());
        }
        #[cfg(not(target_os = "linux"))]
        for kind in [
            InstallationKind::Deb,
            InstallationKind::Rpm,
            InstallationKind::Pacman,
        ] {
            assert!(install(kind, payload).is_err());
        }
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn the_installer_gets_a_private_file_holding_the_verified_bytes() {
        for kind in [
            ArtifactKind::Deb,
            ArtifactKind::Rpm,
            ArtifactKind::Pacman,
            ArtifactKind::Nsis,
            ArtifactKind::Msi,
        ] {
            let package = write_package(kind, b"verified bytes").unwrap();
            assert_eq!(std::fs::read(&package).unwrap(), b"verified bytes");
            assert!(
                package
                    .to_string_lossy()
                    .ends_with(&format!(".{}", kind.extension())),
                "the installer opens its file type"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&package).unwrap().permissions().mode();
                assert_eq!(mode & 0o077, 0, "only this user can open {kind}");
            }
            let path = package.to_path_buf();
            drop(package);
            assert!(!path.exists());
        }
    }

    fn command_line(arguments: &[&str]) -> Result<String, String> {
        let wide: Vec<Vec<u16>> = arguments
            .iter()
            .map(|a| a.encode_utf16().collect())
            .collect();
        quote_command_line(&wide).map(|line| String::from_utf16(&line).unwrap())
    }

    #[test]
    fn launch_arguments_keep_their_boundaries_on_the_windows_command_line() {
        assert_eq!(command_line(&[]).unwrap(), "");
        assert_eq!(
            command_line(&["--port", "9000", "--pass", "p@ss;word"]).unwrap(),
            "--port 9000 --pass p@ss;word"
        );
        // Spaces, tabs and empty arguments are quoted.
        assert_eq!(
            command_line(&["--data-dir", r"C:\My Data", "", "a\tb"]).unwrap(),
            "--data-dir \"C:\\My Data\" \"\" \"a\tb\""
        );
        // Backslashes are literal unless they precede a quote.
        assert_eq!(command_line(&[r"C:\dir\"]).unwrap(), r"C:\dir\");
        assert_eq!(command_line(&[r"C:\a dir\"]).unwrap(), r#""C:\a dir\\""#);
        assert_eq!(command_line(&[r#"say "hi""#]).unwrap(), r#""say \"hi\"""#);
        assert_eq!(command_line(&[r#"a\"b"#]).unwrap(), r#""a\\\"b""#);
        assert_eq!(
            command_line(&["pass\u{00e7}\u{011f}"]).unwrap(),
            "pass\u{00e7}\u{011f}"
        );
    }

    #[test]
    fn launch_arguments_too_long_for_windows_are_refused() {
        let long = "x".repeat(MAX_COMMAND_LINE + 1);
        assert!(command_line(&[&long]).is_err());
        assert!(command_line(&[&long[..MAX_COMMAND_LINE]]).is_ok());
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
