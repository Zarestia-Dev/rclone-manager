//! Installation ownership is independent of the UI/runtime and of file writability.
use super::manifest::ArtifactKind;
use crate::context::AppHandle;
use crate::utils::app::paths::{app_bundle_path, installation_directory};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallationKind {
    /// The desktop app on macOS, whose bundle the core replaces. On Linux and
    /// Windows the package format names it instead.
    MacApp,
    /// The setup of the desktop app or the server, installed for the current user.
    Nsis,
    /// The MSI of the desktop app or the server, installed for all users.
    Msi,
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

impl InstallationKind {
    /// The catalog entry that updates this installation; none for the kinds the
    /// core never installs.
    pub(super) fn artifact(self) -> Option<ArtifactKind> {
        match self {
            Self::Portable => Some(ArtifactKind::Portable),
            Self::Server => Some(ArtifactKind::Server),
            Self::Android => Some(ArtifactKind::Android),
            Self::MacApp => Some(ArtifactKind::App),
            Self::Appimage => Some(ArtifactKind::Appimage),
            Self::Deb => Some(ArtifactKind::Deb),
            Self::Rpm => Some(ArtifactKind::Rpm),
            Self::Pacman => Some(ArtifactKind::Pacman),
            Self::Nsis => Some(ArtifactKind::Nsis),
            Self::Msi => Some(ArtifactKind::Msi),
            Self::Flatpak | Self::Container | Self::Unknown => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePolicy {
    pub installation: InstallationKind,
    pub can_install: bool,
    pub reason: Option<String>,
    /// The pacman package that owns the executable (an AUR package).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    /// A command that updates an externally managed installation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// No installer of ours applies: the release is announced, and the source that
    /// owns the installation installs it. The UI reads `can_install` instead.
    #[serde(skip)]
    pub external: bool,
}

/// Refresh permission checks before every download/apply. No OS password crosses IPC/HTTP.
pub async fn get_update_policy(app: AppHandle) -> UpdatePolicy {
    let build = app.host().installation_kind();
    let flatpak_id = app.product().flatpak_id;
    crate::utils::spawn_blocking(move || detect_policy(build, flatpak_id))
        .await
        .unwrap_or_else(|_| external(InstallationKind::Unknown, None, None))
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

/// The installation kind, and whether the core installs its updates. A package
/// format is installed only when its own package manager owns the executable.
fn classify(
    build: InstallationKind,
    declared: Option<InstallationKind>,
    owner: Option<InstallationKind>,
) -> (InstallationKind, bool) {
    // The server packages hold the server build: the one that installed it is the
    // build the core replaces.
    let build = match (build, owner) {
        (
            InstallationKind::Server,
            Some(
                package @ (InstallationKind::Deb
                | InstallationKind::Rpm
                | InstallationKind::Pacman
                | InstallationKind::Nsis
                | InstallationKind::Msi),
            ),
        ) => package,
        // The desktop's Arch package (and the AUR package) holds the DEB's files,
        // so its binary says DEB.
        (InstallationKind::Deb, Some(InstallationKind::Pacman)) => InstallationKind::Pacman,
        _ => build,
    };
    let kind = declared.unwrap_or(build);
    let packaged = matches!(
        build,
        InstallationKind::Deb | InstallationKind::Rpm | InstallationKind::Pacman
    );
    let installable =
        kind == build && kind != InstallationKind::Unknown && (!packaged || owner == Some(build));
    (kind, installable)
}

fn external(
    installation: InstallationKind,
    package: Option<String>,
    command: Option<String>,
) -> UpdatePolicy {
    UpdatePolicy {
        installation,
        can_install: false,
        reason: Some(if installation == InstallationKind::Unknown {
            crate::localized_error!("backendErrors.updater.unsupportedInstallation")
        } else {
            crate::localized_error!("backendErrors.updater.externallyManaged")
        }),
        package,
        command,
        external: true,
    }
}

fn detect_policy(build: InstallationKind, flatpak_id: &str) -> UpdatePolicy {
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
    let (kind, installable) = classify(build, declared, owner_kind);
    // Only an AUR package needs its name; DEB and RPM names are not shown.
    let package = owner
        .filter(|(owner, _)| *owner == InstallationKind::Pacman && kind == InstallationKind::Pacman)
        .map(|(_, name)| name);
    if !installable {
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
            InstallationKind::Deb | InstallationKind::Rpm | InstallationKind::Pacman
                if !can_install_as_root() =>
            {
                kind.artifact().map(super::package::no_privilege_prompt)
            }
            InstallationKind::Flatpak | InstallationKind::Container | InstallationKind::Unknown => {
                Some(crate::localized_error!(
                    "backendErrors.updater.unsupportedInstallation"
                ))
            }
            // The Windows installers, Android and the macOS app (it asks macOS for
            // administrator rights itself) own their authorization flows.
            _ => None,
        }
    };
    UpdatePolicy {
        installation: kind,
        can_install: reason.is_none(),
        reason,
        package: None,
        command: None,
        external: false,
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
    // The server build is in the server DEB and RPM.
    for (tool, flag, kind) in queries.into_iter().filter(|(_, _, kind)| {
        *kind == InstallationKind::Pacman || *kind == build || build == InstallationKind::Server
    }) {
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
/// is missing, `Err(())` when it did not answer within ten seconds.
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
            Ok(None) if started.elapsed() < std::time::Duration::from_secs(10) => {
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

/// The core installs a package as root through pkexec, whose polkit agent asks for
/// the password, or, where no agent runs, through `sudo -A` with a zenity or
/// kdialog password dialog. Either way the password never reaches the application.
#[cfg(target_os = "linux")]
fn can_install_as_root() -> bool {
    system_program("pkexec").is_some()
        || (system_program("sudo").is_some() && password_dialog().is_some())
}

/// The dialog `sudo -A` asks for the password with. It runs as the user, so the
/// `PATH` may choose it.
#[cfg(target_os = "linux")]
pub(super) fn password_dialog() -> Option<&'static str> {
    ["zenity", "kdialog"]
        .into_iter()
        .find(|dialog| which::which(dialog).is_ok())
}

/// A program that runs as root, looked up in the system folders only: a folder on
/// the user's `PATH` could hold a program of the same name, which the password the
/// user types would then run as root.
#[cfg(target_os = "linux")]
pub(super) fn system_program(name: &str) -> Option<std::path::PathBuf> {
    ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        .into_iter()
        .map(|directory| std::path::Path::new(directory).join(name))
        .find(|path| path.is_file())
}

#[cfg(not(target_os = "linux"))]
fn can_install_as_root() -> bool {
    false
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

/// The server setup (for the current user) and MSI (for all users) record the
/// folder they installed in (`backend/server/package/`).
#[cfg(windows)]
fn package_owner(
    path: &std::path::Path,
    build: InstallationKind,
) -> Option<(InstallationKind, String)> {
    use winreg::{RegKey, enums::*};
    if build != InstallationKind::Server {
        return None;
    }
    let directory = std::fs::canonicalize(path.parent()?).ok()?;
    let installed_by = |root, value: &str| {
        [KEY_WOW64_64KEY, KEY_WOW64_32KEY].into_iter().any(|view| {
            RegKey::predef(root)
                .open_subkey_with_flags(
                    r"Software\Zarestia Dev\RClone Manager Server",
                    KEY_READ | view,
                )
                .and_then(|key| key.get_value::<String, _>(value))
                .ok()
                .and_then(|folder| std::fs::canonicalize(folder).ok())
                .is_some_and(|folder| folder == directory)
        })
    };
    if installed_by(HKEY_CURRENT_USER, "") {
        Some((InstallationKind::Nsis, String::new()))
    } else if installed_by(HKEY_LOCAL_MACHINE, "MsiInstallFolder") {
        Some((InstallationKind::Msi, String::new()))
    } else {
        None
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn package_owner(
    _path: &std::path::Path,
    _build: InstallationKind,
) -> Option<(InstallationKind, String)> {
    None
}

#[cfg(test)]
pub(crate) fn test_policy(
    installation: InstallationKind,
    external: bool,
    reason: Option<&str>,
) -> UpdatePolicy {
    UpdatePolicy {
        installation,
        can_install: reason.is_none(),
        reason: reason.map(Into::into),
        package: None,
        command: None,
        external,
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
    fn desktop_packages_update_through_the_core_only_when_their_manager_owns_them() {
        for kind in [Deb, Rpm] {
            let owned = Some(kind);
            assert_eq!(
                classify(kind, declared_kind(None, false, owned), owned),
                (kind, true)
            );
            // A package format that no package manager owns is not reinstalled.
            assert_eq!(
                classify(kind, declared_kind(Some("deb"), false, None), None),
                (Deb, false)
            );
        }
        // The Arch package and the AUR package hold the DEB's files, so the binary
        // still says DEB; pacman owns it.
        let pacman = Some(Pacman);
        assert_eq!(
            classify(Deb, declared_kind(None, false, pacman), pacman),
            (Pacman, true)
        );
        // An RPM build that pacman owns is not a package this release makes.
        assert_eq!(
            classify(Rpm, declared_kind(None, false, pacman), pacman),
            (Pacman, false)
        );
    }

    #[test]
    fn package_ownership_overrides_repackaged_and_portable_builds() {
        for owner in [Pacman, Deb, Rpm] {
            for build in [Portable, Appimage, MacApp] {
                let declared = declared_kind(None, false, Some(owner));
                assert_eq!(classify(build, declared, Some(owner)), (owner, false));
            }
        }
    }

    #[test]
    fn the_server_packages_update_the_server_build_they_installed() {
        // The AUR package holds the same files as the release's Arch package.
        for owner in [Deb, Rpm, Pacman, Nsis, Msi] {
            let declared = declared_kind(None, false, Some(owner));
            assert_eq!(classify(Server, declared, Some(owner)), (owner, true));
        }
        // A container or a declaration without an owner is not ours.
        assert_eq!(
            classify(
                Server,
                declared_kind(Some("docker"), false, Some(Deb)),
                Some(Deb)
            ),
            (Container, false)
        );
        assert_eq!(
            classify(Server, declared_kind(Some("deb"), false, None), None),
            (Deb, false)
        );
    }

    #[test]
    fn deployment_can_disable_but_cannot_enable_native_updates() {
        for (hint, kind) in [
            (" Docker ", Container),
            ("AUR", Pacman),
            ("flatpak", Flatpak),
        ] {
            assert_eq!(
                classify(Portable, declared_kind(Some(hint), false, None), None),
                (kind, false)
            );
        }
        for hint in [None, Some(""), Some("native"), Some("unknown")] {
            assert_eq!(
                classify(Unknown, declared_kind(hint, false, None), None),
                (Unknown, false)
            );
        }
        assert_eq!(
            classify(Server, declared_kind(None, true, None), None),
            (Flatpak, false)
        );
        // The builds the core replaces itself, whatever they were bundled as.
        for build in [Portable, Server, Android, Appimage, Nsis, Msi, MacApp] {
            assert_eq!(classify(build, None, None), (build, true));
        }
        // Nothing is known about this build, so nothing is installed.
        assert_eq!(classify(Unknown, None, None), (Unknown, false));
    }

    #[test]
    fn every_installation_the_core_updates_has_its_own_catalog_entry() {
        let artifacts: Vec<_> = [
            Portable, Server, Android, MacApp, Appimage, Deb, Rpm, Pacman, Nsis, Msi,
        ]
        .map(|kind| kind.artifact().unwrap().to_string())
        .into();
        let mut unique = artifacts.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), artifacts.len());
        for kind in [Flatpak, Container, Unknown] {
            assert!(kind.artifact().is_none());
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
            update_command(Pacman, Some("rclone-manager-server"), None, id).unwrap(),
            "git clone https://aur.archlinux.org/rclone-manager-server.git && cd rclone-manager-server && makepkg -si"
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
