//! Installation ownership is independent of the UI/runtime and of file writability.
use crate::context::AppHandle;
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
}

impl UpdatePolicy {
    fn external(installation: InstallationKind) -> Self {
        Self {
            installation,
            method: UpdateMethod::Unavailable,
            can_install: false,
            reason: Some(if installation == InstallationKind::Unknown {
                crate::localized_error!("backendErrors.updater.unsupportedInstallation")
            } else {
                crate::localized_error!("backendErrors.updater.externallyManaged")
            }),
        }
    }
}

/// Refresh permission checks before every download/apply. No OS password crosses IPC/HTTP.
pub async fn get_update_policy(app: AppHandle) -> UpdatePolicy {
    let method = app.host().update_method();
    let portable = app.host().is_portable_installation();
    crate::utils::spawn_blocking(move || detect_policy(method, portable))
        .await
        .unwrap_or_else(|_| UpdatePolicy::external(InstallationKind::Unknown))
}

pub async fn can_auto_install(app: AppHandle) -> bool {
    get_update_policy(app).await.can_install
}

fn select_kind(
    method: UpdateMethod,
    deployment: Option<&str>,
    package: Option<InstallationKind>,
    appimage: bool,
    flatpak: bool,
    portable: bool,
) -> InstallationKind {
    let deployment = deployment.unwrap_or_default().trim().to_ascii_lowercase();
    match deployment.as_str() {
        "docker" | "container" => return InstallationKind::Container,
        "flatpak" => return InstallationKind::Flatpak,
        "aur" | "pacman" => return InstallationKind::Pacman,
        "deb" => return InstallationKind::Deb,
        "rpm" => return InstallationKind::Rpm,
        _ => {}
    }
    if flatpak {
        return InstallationKind::Flatpak;
    }
    if let Some(package) = package {
        return package;
    }
    if portable {
        return InstallationKind::Portable;
    }
    if method == UpdateMethod::Android {
        return InstallationKind::Android;
    }
    if method == UpdateMethod::Binary {
        return InstallationKind::Server;
    }
    if appimage {
        return InstallationKind::Appimage;
    }
    if method == UpdateMethod::Tauri && !cfg!(target_os = "linux") {
        return InstallationKind::Native;
    }
    InstallationKind::Unknown
}

fn detect_policy(method: UpdateMethod, portable: bool) -> UpdatePolicy {
    let executable = std::env::current_exe().ok();
    let kind = select_kind(
        method,
        std::env::var("RCLONE_MANAGER_INSTALLATION_TYPE")
            .ok()
            .as_deref(),
        executable.as_deref().and_then(package_owner),
        std::env::var_os("APPIMAGE").is_some(),
        cfg!(feature = "flatpak") || std::path::Path::new("/.flatpak-info").exists(),
        portable,
    );
    let method_matches = matches!(
        (kind, method),
        (
            InstallationKind::Native | InstallationKind::Appimage,
            UpdateMethod::Tauri
        ) | (
            InstallationKind::Portable | InstallationKind::Server,
            UpdateMethod::Binary
        ) | (InstallationKind::Android, UpdateMethod::Android)
    );
    if !method_matches {
        return UpdatePolicy::external(kind);
    }
    let disabled = std::env::var("RCLONE_MANAGER_DISABLE_UPDATES")
        .is_ok_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1"));
    let writable = match kind {
        InstallationKind::Portable | InstallationKind::Server => executable
            .as_deref()
            .is_some_and(|p| writable_binary(p).is_ok()),
        InstallationKind::Appimage => std::env::var_os("APPIMAGE")
            .is_some_and(|p| writable_binary(std::path::Path::new(&p)).is_ok()),
        _ => true, // Native installers and Android own their authorization flows.
    };
    let reason = if disabled {
        Some(crate::localized_error!(
            "backendErrors.updater.disabledByAdministrator"
        ))
    } else if !writable {
        Some(crate::localized_error!("backendErrors.updater.notWritable"))
    } else if !cfg!(feature = "updater") {
        Some(crate::localized_error!(
            "backendErrors.updater.unsupportedInstallation"
        ))
    } else {
        None
    };
    UpdatePolicy {
        installation: kind,
        method,
        can_install: reason.is_none(),
        reason,
    }
}

pub(crate) fn writable_binary(path: &std::path::Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.permissions().readonly() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Invalid update target",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Preserve ownership instead of silently replacing another user's executable.
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Update target belongs to another user",
            ));
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing installation directory"))?;
    tempfile::NamedTempFile::new_in(parent)?.close()
}

#[cfg(target_os = "linux")]
fn package_owner(path: &std::path::Path) -> Option<InstallationKind> {
    use std::process::{Command, Stdio};
    // Cache only ownership, never writability. The executable's owner does not
    // change during a normal session, and package queries must not block IPC.
    static OWNER: std::sync::OnceLock<Option<InstallationKind>> = std::sync::OnceLock::new();
    *OWNER.get_or_init(|| {
        for (tool, flag, kind) in [
            ("pacman", "-Qo", InstallationKind::Pacman),
            ("dpkg-query", "-S", InstallationKind::Deb),
            ("rpm", "-qf", InstallationKind::Rpm),
        ] {
            let Ok(mut child) = Command::new(tool)
                .arg(flag)
                .arg(path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            else {
                continue;
            };
            let started = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if status.success() {
                            return Some(kind);
                        }
                        break;
                    }
                    Ok(None) if started.elapsed() < std::time::Duration::from_secs(2) => {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        None
    })
}

#[cfg(not(target_os = "linux"))]
fn package_owner(_path: &std::path::Path) -> Option<InstallationKind> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_ownership_overrides_repackaged_and_portable_builds() {
        for kind in [
            InstallationKind::Pacman,
            InstallationKind::Deb,
            InstallationKind::Rpm,
        ] {
            for method in [UpdateMethod::Tauri, UpdateMethod::Binary] {
                assert_eq!(
                    select_kind(method, None, Some(kind), false, false, true),
                    kind
                );
            }
        }
    }

    #[test]
    fn deployment_can_disable_but_cannot_enable_native_updates() {
        for (hint, kind) in [
            (" Docker ", InstallationKind::Container),
            ("AUR", InstallationKind::Pacman),
            ("flatpak", InstallationKind::Flatpak),
        ] {
            assert_eq!(
                select_kind(UpdateMethod::Binary, Some(hint), None, false, false, true),
                kind
            );
        }
        for hint in [None, Some(""), Some("native"), Some("unknown")] {
            assert_eq!(
                select_kind(UpdateMethod::Unavailable, hint, None, false, false, false),
                InstallationKind::Unknown
            );
        }
    }

    #[test]
    fn hosts_and_packaging_are_independent() {
        assert_eq!(
            select_kind(UpdateMethod::Binary, None, None, false, false, true),
            InstallationKind::Portable
        );
        assert_eq!(
            select_kind(UpdateMethod::Binary, None, None, false, false, false),
            InstallationKind::Server
        );
        assert_eq!(
            select_kind(UpdateMethod::Android, None, None, false, false, false),
            InstallationKind::Android
        );
        assert_eq!(
            select_kind(UpdateMethod::Tauri, None, None, true, false, false),
            InstallationKind::Appimage
        );
        assert_eq!(
            select_kind(UpdateMethod::Binary, None, None, false, true, false),
            InstallationKind::Flatpak
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
