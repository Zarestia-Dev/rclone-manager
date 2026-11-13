//! Installation ownership is independent of the UI/runtime and of file writability.
use crate::context::AppHandle;
use crate::utils::app::paths::{app_bundle_path, installation_directory};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateMethod {
    #[default]
    Unavailable,
    Tauri,
    Binary,
    Android,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallationKind {
    Native,
    Portable,
    Server,
    Android,
    Appimage,
    Pacman,
    Deb,
    Rpm,
    Flatpak,
    Container,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePolicy {
    pub installation: InstallationKind,
    pub method: UpdateMethod,
    pub can_install: bool,
    pub reason: Option<String>,
    /// The pacman package that owns the executable (an AUR package).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    /// A command that updates an externally managed installation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// Refresh permission checks before every download/apply. No OS password crosses IPC/HTTP.
pub async fn get_update_policy(app: AppHandle) -> UpdatePolicy {
    let host = app.host();
    let method = host.update_method();
    let build = build_kind(
        method,
        host.is_portable_installation(),
        host.native_bundle(),
        std::env::var_os("APPIMAGE").is_some(),
    );
    let flatpak_id = app.product().flatpak_id;
    crate::utils::spawn_blocking(move || detect_policy(method, build, flatpak_id))
        .await
        .unwrap_or_else(|_| external(InstallationKind::Unknown, None, None))
}

/// The installation this build can replace by itself, from the host alone.
fn build_kind(
    method: UpdateMethod,
    portable: bool,
    bundle: Option<InstallationKind>,
    appimage: bool,
) -> InstallationKind {
    match method {
        UpdateMethod::Binary if portable => InstallationKind::Portable,
        UpdateMethod::Binary => InstallationKind::Server,
        UpdateMethod::Android => InstallationKind::Android,
        UpdateMethod::Tauri if !cfg!(target_os = "linux") => InstallationKind::Native,
        // Linux builds are told apart by the package format Tauri patched into them.
        UpdateMethod::Tauri => match bundle {
            Some(kind @ (InstallationKind::Deb | InstallationKind::Rpm)) => kind,
            // Tauri's AppImage installer also handles a build without the marker.
            Some(InstallationKind::Appimage) | None if appimage => InstallationKind::Appimage,
            _ => InstallationKind::Unknown,
        },
        UpdateMethod::Unavailable => InstallationKind::Unknown,
    }
}

/// Ownership declared by the deployment or found on the system. It decides the
/// installation kind; the build's own installer runs only when both agree.
fn declared_kind(
    deployment: Option<&str>,
    flatpak: bool,
    owner: Option<InstallationKind>,
) -> Option<InstallationKind> {
    let deployment = deployment.unwrap_or_default().trim().to_ascii_lowercase();
    let declared = match deployment.as_str() {
        "docker" | "container" => Some(InstallationKind::Container),
        "flatpak" => Some(InstallationKind::Flatpak),
        "aur" | "pacman" => Some(InstallationKind::Pacman),
        "deb" => Some(InstallationKind::Deb),
        "rpm" => Some(InstallationKind::Rpm),
        _ => None,
    };
    declared
        .or(flatpak.then_some(InstallationKind::Flatpak))
        .or(owner)
}

/// The kind and installer for a build. A package format is installed by Tauri
/// only when its own package manager owns the executable: AUR packages repackage
/// the upstream DEB, and Tauri would run `dpkg` on them.
fn classify(
    method: UpdateMethod,
    build: InstallationKind,
    declared: Option<InstallationKind>,
    owner: Option<InstallationKind>,
) -> (InstallationKind, UpdateMethod) {
    let kind = declared.unwrap_or(build);
    let packaged = matches!(build, InstallationKind::Deb | InstallationKind::Rpm);
    if kind == build && kind != InstallationKind::Unknown && (!packaged || owner == Some(build)) {
        (kind, method)
    } else {
        (kind, UpdateMethod::Unavailable)
    }
}

fn external(
    installation: InstallationKind,
    package: Option<String>,
    command: Option<String>,
) -> UpdatePolicy {
    UpdatePolicy {
        installation,
        method: UpdateMethod::Unavailable,
        can_install: false,
        reason: Some(if installation == InstallationKind::Unknown {
            crate::localized_error!("backendErrors.updater.unsupportedInstallation")
        } else {
            crate::localized_error!("backendErrors.updater.externallyManaged")
        }),
        package,
        command,
    }
}

fn detect_policy(method: UpdateMethod, build: InstallationKind, flatpak_id: &str) -> UpdatePolicy {
    let executable = std::env::current_exe().ok();
    let owner = executable
        .as_deref()
        .and_then(|path| package_owner(path, build));
    let owner_kind = owner.as_ref().map(|(kind, _)| *kind);
    let declared = declared_kind(
        crate::utils::app::platform::deployment_type().as_deref(),
        cfg!(feature = "flatpak") || std::path::Path::new("/.flatpak-info").exists(),
        owner_kind,
    );
    let (kind, method) = classify(method, build, declared, owner_kind);
    // Only an AUR package needs its name; DEB and RPM names are not shown.
    let package = owner
        .filter(|(owner, _)| *owner == InstallationKind::Pacman && kind == InstallationKind::Pacman)
        .map(|(_, name)| name);
    if method == UpdateMethod::Unavailable {
        let helper = ["paru", "yay"]
            .into_iter()
            .find(|helper| which::which(helper).is_ok());
        let command = update_command(kind, package.as_deref(), helper, flatpak_id);
        return external(kind, package, command);
    }
    let disabled = std::env::var("RCLONE_MANAGER_DISABLE_UPDATES")
        .is_ok_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1"));
    let reason = if disabled {
        Some(crate::localized_error!(
            "backendErrors.updater.disabledByAdministrator"
        ))
    } else if !cfg!(feature = "updater") {
        Some(crate::localized_error!(
            "backendErrors.updater.unsupportedInstallation"
        ))
    } else {
        match kind {
            InstallationKind::Portable | InstallationKind::Server
                if !executable
                    .as_deref()
                    .is_some_and(|p| writable_binary(p).is_ok()) =>
            {
                Some(crate::localized_error!("backendErrors.updater.notWritable"))
            }
            InstallationKind::Appimage
                if !std::env::var_os("APPIMAGE")
                    .is_some_and(|p| writable_binary(std::path::Path::new(&p)).is_ok()) =>
            {
                Some(crate::localized_error!("backendErrors.updater.notWritable"))
            }
            // Tauri asks for the administrator password through one of these.
            InstallationKind::Deb | InstallationKind::Rpm
                if !["pkexec", "zenity", "kdialog"]
                    .iter()
                    .any(|tool| which::which(tool).is_ok()) =>
            {
                Some(crate::localized_error!(
                    "backendErrors.updater.noPrivilegePrompt"
                ))
            }
            // Native installers and Android own their authorization flows.
            _ => None,
        }
    };
    UpdatePolicy {
        installation: kind,
        method,
        can_install: reason.is_none(),
        reason,
        package: None,
        command: None,
    }
}

/// What a user runs to update an installation the app cannot replace itself.
fn update_command(
    kind: InstallationKind,
    package: Option<&str>,
    aur_helper: Option<&str>,
    flatpak_id: &str,
) -> Option<String> {
    match kind {
        InstallationKind::Pacman => {
            let package = package?;
            Some(match aur_helper {
                Some(helper) => format!("{helper} -S {package}"),
                None => format!(
                    "git clone https://aur.archlinux.org/{package}.git && cd {package} && makepkg -si"
                ),
            })
        }
        InstallationKind::Flatpak => Some(format!("flatpak update {flatpak_id}")),
        // The compose file names the image tag the user chose.
        InstallationKind::Container => Some("docker compose pull && docker compose up -d".into()),
        _ => None,
    }
}

pub(crate) fn writable_binary(path: &std::path::Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.permissions().readonly() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            crate::localized_error!("backendErrors.updater.notWritable"),
        ));
    }
    owned_by_current_user(&metadata)?;
    if let Some(bundle) = app_bundle_path(path) {
        let metadata = std::fs::symlink_metadata(bundle)?;
        if !metadata.is_dir() {
            return Err(std::io::Error::other(crate::localized_error!(
                "backendErrors.updater.invalidBundle"
            )));
        }
        owned_by_current_user(&metadata)?;
    }
    tempfile::NamedTempFile::new_in(installation_directory(path)?)?.close()
}

/// Preserve ownership instead of silently replacing another user's files.
fn owned_by_current_user(metadata: &std::fs::Metadata) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                crate::localized_error!("backendErrors.updater.ownedByAnotherUser"),
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    Ok(())
}

/// The package manager that owns `path`, with the package name it reports.
/// pacman is always asked: AUR packages repackage the DEB, so their binary says
/// DEB. A DEB or RPM build is then checked against its own manager, so a copy
/// unpacked elsewhere is never reinstalled system-wide.
#[cfg(target_os = "linux")]
fn package_owner(
    path: &std::path::Path,
    build: InstallationKind,
) -> Option<(InstallationKind, String)> {
    // The executable's owner does not change during a session, and package
    // queries must not block IPC. Never cache an answer a timeout cut short.
    static OWNER: std::sync::OnceLock<Option<(InstallationKind, String)>> =
        std::sync::OnceLock::new();
    if let Some(owner) = OWNER.get() {
        return owner.clone();
    }
    let mut timed_out = false;
    let mut owner = None;
    let queries = [
        ("pacman", "-Qqo", InstallationKind::Pacman),
        ("dpkg-query", "-S", InstallationKind::Deb),
        ("rpm", "-qf", InstallationKind::Rpm),
    ];
    for (tool, flag, kind) in queries
        .into_iter()
        .filter(|(_, _, kind)| *kind == InstallationKind::Pacman || *kind == build)
    {
        match query_owner(tool, flag, path) {
            Ok(Some(name)) => {
                owner = Some((kind, name));
                break;
            }
            Ok(None) => {}
            Err(()) => timed_out = true,
        }
    }
    if owner.is_some() || !timed_out {
        let _ = OWNER.set(owner.clone());
    }
    owner
}

/// `Ok(Some(name))` when `tool` reports an owner, `Ok(None)` when it does not or
/// is missing, `Err(())` when it did not answer within two seconds.
#[cfg(target_os = "linux")]
fn query_owner(tool: &str, flag: &str, path: &std::path::Path) -> Result<Option<String>, ()> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(tool)
        .arg(flag)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Ok(None);
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut output);
                }
                return Ok(Some(owner_name(&output)));
            }
            Ok(Some(_)) => return Ok(None),
            Ok(None) if started.elapsed() < std::time::Duration::from_secs(2) => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
            Err(_) => return Ok(None),
        }
    }
}

/// `pacman -Qqo` prints the name; `dpkg-query -S` prints `name: path`.
#[cfg(target_os = "linux")]
fn owner_name(output: &str) -> String {
    let line = output.lines().next().unwrap_or_default();
    line.split_once(": ")
        .map_or(line, |(name, _)| name)
        .trim()
        .to_owned()
}

#[cfg(not(target_os = "linux"))]
fn package_owner(
    _path: &std::path::Path,
    _build: InstallationKind,
) -> Option<(InstallationKind, String)> {
    None
}

#[cfg(test)]
pub(crate) fn test_policy(
    installation: InstallationKind,
    method: UpdateMethod,
    reason: Option<&str>,
) -> UpdatePolicy {
    UpdatePolicy {
        installation,
        method,
        can_install: reason.is_none(),
        reason: reason.map(Into::into),
        package: None,
        command: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use InstallationKind::*;

    #[cfg(unix)]
    #[test]
    fn bundle_permissions_are_checked_at_the_directory_that_will_be_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary = root
            .path()
            .join("Portable.app/Contents/MacOS/rclone-manager");
        let inner = binary.parent().unwrap();
        std::fs::create_dir_all(inner).unwrap();
        std::fs::write(&binary, b"app").unwrap();
        assert!(writable_binary(&binary).is_ok());

        std::fs::set_permissions(inner, std::fs::Permissions::from_mode(0o555)).unwrap();
        let with_read_only_inner = writable_binary(&binary);
        std::fs::set_permissions(inner, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(with_read_only_inner.is_ok());

        // Root bypasses directory permissions; the other assertions still apply there.
        if unsafe { libc::geteuid() } != 0 {
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
            let with_read_only_parent = writable_binary(&binary);
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(with_read_only_parent.is_err());
        }
    }

    #[test]
    fn hosts_report_the_installation_they_can_replace() {
        assert_eq!(
            build_kind(UpdateMethod::Binary, true, None, false),
            Portable
        );
        assert_eq!(build_kind(UpdateMethod::Binary, false, None, false), Server);
        assert_eq!(
            build_kind(UpdateMethod::Android, false, None, false),
            Android
        );
        assert_eq!(
            build_kind(UpdateMethod::Unavailable, false, Some(Deb), false),
            Unknown
        );
        if cfg!(target_os = "linux") {
            for kind in [Deb, Rpm] {
                assert_eq!(
                    build_kind(UpdateMethod::Tauri, false, Some(kind), false),
                    kind
                );
            }
            assert_eq!(
                build_kind(UpdateMethod::Tauri, false, Some(Appimage), true),
                Appimage
            );
            // An extracted AppImage or an unbundled build has nothing to replace.
            assert_eq!(
                build_kind(UpdateMethod::Tauri, false, Some(Appimage), false),
                Unknown
            );
            assert_eq!(build_kind(UpdateMethod::Tauri, false, None, false), Unknown);
            assert_eq!(build_kind(UpdateMethod::Tauri, false, None, true), Appimage);
        } else {
            assert_eq!(build_kind(UpdateMethod::Tauri, false, None, false), Native);
        }
    }

    #[test]
    fn native_packages_update_through_tauri_only_when_their_manager_owns_them() {
        for kind in [Deb, Rpm] {
            let owned = Some(kind);
            assert_eq!(
                classify(
                    UpdateMethod::Tauri,
                    kind,
                    declared_kind(None, false, owned),
                    owned
                ),
                (kind, UpdateMethod::Tauri)
            );
            // A package format that no package manager owns is not reinstalled.
            assert_eq!(
                classify(
                    UpdateMethod::Tauri,
                    kind,
                    declared_kind(Some("deb"), false, None),
                    None
                ),
                (Deb, UpdateMethod::Unavailable)
            );
        }
        // AUR packages repackage the DEB, so the binary still says DEB.
        let pacman = Some(Pacman);
        assert_eq!(
            classify(
                UpdateMethod::Tauri,
                Deb,
                declared_kind(None, false, pacman),
                pacman
            ),
            (Pacman, UpdateMethod::Unavailable)
        );
    }

    #[test]
    fn package_ownership_overrides_repackaged_and_portable_builds() {
        for owner in [Pacman, Deb, Rpm] {
            for build in [Portable, Server, Appimage, Native] {
                let declared = declared_kind(None, false, Some(owner));
                assert_eq!(
                    classify(UpdateMethod::Binary, build, declared, Some(owner)),
                    (owner, UpdateMethod::Unavailable)
                );
            }
        }
    }

    #[test]
    fn deployment_can_disable_but_cannot_enable_native_updates() {
        for (hint, kind) in [
            (" Docker ", Container),
            ("AUR", Pacman),
            ("flatpak", Flatpak),
        ] {
            assert_eq!(
                classify(
                    UpdateMethod::Binary,
                    Portable,
                    declared_kind(Some(hint), false, None),
                    None
                ),
                (kind, UpdateMethod::Unavailable)
            );
        }
        for hint in [None, Some(""), Some("native"), Some("unknown")] {
            assert_eq!(
                classify(
                    UpdateMethod::Unavailable,
                    Unknown,
                    declared_kind(hint, false, None),
                    None
                ),
                (Unknown, UpdateMethod::Unavailable)
            );
        }
        assert_eq!(
            classify(
                UpdateMethod::Binary,
                Server,
                declared_kind(None, true, None),
                None
            ),
            (Flatpak, UpdateMethod::Unavailable)
        );
        for (build, method) in [
            (Portable, UpdateMethod::Binary),
            (Server, UpdateMethod::Binary),
            (Android, UpdateMethod::Android),
            (Appimage, UpdateMethod::Tauri),
            (Native, UpdateMethod::Tauri),
        ] {
            assert_eq!(classify(method, build, None, None), (build, method));
        }
    }

    #[test]
    fn external_installations_get_the_command_that_updates_them() {
        let id = "io.example.app";
        assert_eq!(
            update_command(Pacman, Some("rclone-manager"), Some("paru"), id).unwrap(),
            "paru -S rclone-manager"
        );
        assert_eq!(
            update_command(Pacman, Some("rclone-manager-headless"), None, id).unwrap(),
            "git clone https://aur.archlinux.org/rclone-manager-headless.git && cd rclone-manager-headless && makepkg -si"
        );
        assert!(update_command(Pacman, None, Some("yay"), id).is_none());
        assert_eq!(
            update_command(Flatpak, None, None, id).unwrap(),
            "flatpak update io.example.app"
        );
        assert!(update_command(Container, None, None, id).is_some());
        for kind in [Deb, Rpm, Unknown, Portable] {
            assert!(update_command(kind, None, Some("paru"), id).is_none());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn owner_names_come_from_each_package_query() {
        assert_eq!(owner_name("rclone-manager\n"), "rclone-manager");
        assert_eq!(
            owner_name("rclone-manager: /usr/bin/rclone-manager\n"),
            "rclone-manager"
        );
        assert_eq!(owner_name(""), "");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn package_queries_report_missing_tools_and_unowned_files_as_not_owned() {
        let path = std::path::Path::new("/nonexistent/rclone-manager");
        assert_eq!(query_owner("rcman-missing-tool", "-Qqo", path), Ok(None));
        assert_eq!(query_owner("false", "", path), Ok(None));
        assert_eq!(
            query_owner("echo", "owner", path),
            Ok(Some("owner /nonexistent/rclone-manager".into()))
        );
    }

    #[test]
    fn update_target_must_be_an_owned_writable_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("binary with ' spaces");
        std::fs::write(&path, b"old").unwrap();
        assert!(writable_binary(&path).is_ok());
        assert!(writable_binary(dir.path()).is_err());
        assert!(writable_binary(&dir.path().join("missing")).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(writable_binary(&link).is_err());
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
            assert!(writable_binary(&path).is_err());
        }
    }
}
