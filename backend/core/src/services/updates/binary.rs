//! Stage verified artifacts; only the helper replaces a stopped application.
use super::manifest::{Manifest, PUBLIC_KEY};
use crate::utils::app::paths::{app_bundle_path, installation_directory};
use crate::utils::types::updater::InstallOutcome;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct StagedUpdate {
    pub(super) kind: String,
    pub(super) target: PathBuf,
    pub(super) args: Vec<std::ffi::OsString>,
    pub(super) working_directory: PathBuf,
    #[serde(default)]
    pub(super) parent_pid: u32,
}

pub(crate) fn prepare(
    kind: &str,
    manifest: &[u8],
    signature: &str,
    payload: &[u8],
) -> Result<InstallOutcome, String> {
    let target = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| e.to_string())?;
    super::policy::writable_binary(&target).map_err(|e| e.to_string())?;
    let supervisor = std::env::var_os(super::health::DIRECTORY_ENV)
        .map(PathBuf::from)
        .filter(|directory| supervisor_active(directory, &target));
    if let Some(active) = &supervisor
        && !active.join("committed").is_file()
    {
        return Err("Current update has not finished startup verification".into());
    }
    prune_completed(&target);
    let directory = tempfile::Builder::new()
        .prefix(".rcman-update-")
        .tempdir_in(installation_directory(&target).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let plan = StagedUpdate {
        kind: kind.into(),
        target,
        args: std::env::args_os().skip(1).collect(),
        working_directory: std::env::current_dir().map_err(|e| e.to_string())?,
        parent_pid: std::process::id(),
    };
    let stage = directory.path();
    for (name, bytes) in [
        ("manifest.json", manifest),
        ("manifest.sig", signature.as_bytes()),
        ("payload", payload),
        (
            "plan.json",
            &serde_json::to_vec(&plan).map_err(|e| e.to_string())?,
        ),
        (
            "target.json",
            &serde_json::to_vec(&plan.target).map_err(|e| e.to_string())?,
        ),
    ] {
        write_private(&stage.join(name), bytes).map_err(|e| e.to_string())?;
    }
    preserve_previous(stage, &plan.target).map_err(|e| e.to_string())?;
    if let Some(active) = supervisor {
        // The existing supervisor consumes this only after its child exits cleanly.
        write_private(
            &active.join("next.json"),
            &serde_json::to_vec(stage).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let _ = directory.keep();
        return Ok(InstallOutcome::Exit);
    }
    #[cfg(windows)]
    {
        std::fs::copy(&plan.target, stage.join("updater.exe")).map_err(|e| e.to_string())?;
        let mut command = std::process::Command::new(stage.join("updater.exe"));
        use std::os::windows::process::CommandExt;
        command
            .arg("--rcman-update-helper")
            .arg(stage)
            .creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        if let Err(error) = wait_for_helper(&mut child, stage, std::time::Duration::from_secs(30)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
        let _ = directory.keep();
        Ok(InstallOutcome::Exit)
    }
    #[cfg(not(windows))]
    {
        let retained = directory.keep();
        Ok(InstallOutcome::RestartBinary {
            executable: plan.target,
            previous: retained.join("previous"),
            arguments: plan.args,
            working_directory: plan.working_directory,
        })
    }
}

#[cfg(windows)]
fn wait_for_helper(
    child: &mut std::process::Child,
    directory: &Path,
    timeout: std::time::Duration,
) -> std::io::Result<()> {
    let start = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(std::io::Error::other(format!(
                "Update helper exited: {status}"
            )));
        }
        if directory.join("helper-ready").is_file() {
            return Ok(());
        }
        if start.elapsed() >= timeout {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Update helper did not become ready",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(unix)]
pub fn restart(
    executable: &Path,
    previous: &Path,
    arguments: &[std::ffi::OsString],
    working_directory: &Path,
) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let directory = previous.parent().ok_or("Missing recovery directory")?;
    let error = std::process::Command::new(previous)
        .arg("--rcman-update-supervisor")
        .arg(directory)
        .current_dir(working_directory)
        .env_remove(super::health::DIRECTORY_ENV)
        .env_remove(super::health::TOKEN_ENV)
        .exec();
    // No replacement has happened yet. Restart the still-installed original.
    Err(format!(
        "Helper failed: {error}; restarting application failed: {}",
        std::process::Command::new(executable)
            .args(arguments)
            .current_dir(working_directory)
            .exec()
    ))
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn preserve_previous(directory: &Path, target: &Path) -> std::io::Result<()> {
    let previous = directory.join("previous");
    #[cfg(unix)]
    std::fs::hard_link(target, &previous)?;
    #[cfg(not(unix))]
    {
        std::fs::copy(target, &previous)?;
    }
    // A Unix hard link still names the running executable (ETXTBSY on write
    // open). Windows FlushFileBuffers needs a writable handle to its copy.
    #[cfg(unix)]
    let file = std::fs::File::open(previous)?;
    #[cfg(not(unix))]
    let file = std::fs::OpenOptions::new().write(true).open(previous)?;
    file.sync_all()
}

fn read_manifest(directory: &Path, expected_kind: &str, key: &str) -> std::io::Result<Manifest> {
    let bytes = std::fs::read(directory.join("manifest.json"))?;
    let signature = std::fs::read_to_string(directory.join("manifest.sig"))?;
    let manifest = Manifest::from_signed(&bytes, &signature, key).map_err(std::io::Error::other)?;
    manifest
        .validate(&manifest.version, expected_kind, &super::manifest::target())
        .map_err(std::io::Error::other)?;
    Ok(manifest)
}

fn install_staged(
    directory: &Path,
    plan: &StagedUpdate,
    current_version: &str,
    key: &str,
) -> Result<String, String> {
    let manifest = read_manifest(directory, &plan.kind, key).map_err(|e| e.to_string())?;
    if !super::is_version_newer(current_version, &manifest.version) {
        return Err("Update version must increase across supervisor handoffs".into());
    }
    let payload = std::fs::read(directory.join("payload")).map_err(|e| e.to_string())?;
    manifest.verify_install_payload(&payload, key)?;
    if let Some(root) = manifest.bundle_root() {
        replace_bundle(directory, &plan.target, &payload, root, &manifest, key)?;
    } else {
        replace_verified(directory, &plan.target).map_err(|e| e.to_string())?;
    }
    manifest.verify_payload_with_key(
        &std::fs::read(&plan.target).map_err(|e| e.to_string())?,
        key,
    )?;
    Ok(manifest.version)
}

fn replace_bundle(
    directory: &Path,
    target: &Path,
    payload: &[u8],
    root: &str,
    manifest: &Manifest,
    key: &str,
) -> Result<(), String> {
    use crate::utils::archive::extract_zip_bundle;
    super::policy::writable_binary(target).map_err(|e| e.to_string())?;
    let bundle = app_bundle_path(target).ok_or("Portable app is not in a macOS bundle")?;
    if !directory.join("previous").is_file() {
        return Err("Missing previous executable".into());
    }
    let candidate = directory.join("candidate");
    extract_zip_bundle(payload, &candidate, root)?;
    let candidate_bundle = candidate.join(root);
    let binary = candidate_bundle.join(target.strip_prefix(bundle).map_err(|e| e.to_string())?);
    if !candidate_bundle.join("Contents/Info.plist").is_file() {
        return Err("Portable app bundle has no Info.plist".into());
    }
    manifest.verify_payload_with_key(&std::fs::read(&binary).map_err(|e| e.to_string())?, key)?;
    std::fs::set_permissions(
        &binary,
        std::fs::metadata(target)
            .map_err(|e| e.to_string())?
            .permissions(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(bundle, directory.join("previous.app")).map_err(|e| e.to_string())?;
    std::fs::rename(candidate_bundle, bundle).map_err(|e| e.to_string())?;
    sync_parent(bundle).map_err(|e| e.to_string())
}

fn replace_verified(directory: &Path, target: &Path) -> std::io::Result<()> {
    replace_with_sync(directory, target, sync_parent)
}

fn replace_with_sync(
    directory: &Path,
    target: &Path,
    sync: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    super::policy::writable_binary(target)?;
    // Preparation must have preserved the original before the application exits.
    if !directory.join("previous").is_file() {
        return Err(std::io::Error::other("Missing previous executable"));
    }
    let payload = directory.join("payload");
    std::fs::set_permissions(&payload, std::fs::metadata(target)?.permissions())?;
    #[cfg(windows)]
    std::fs::remove_file(target)?;
    std::fs::rename(payload, target)?;
    // All errors here, including post-rename sync failures, go through recovery.
    sync(target)
}

fn sync_parent(target: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    std::fs::File::open(
        target
            .parent()
            .ok_or_else(|| std::io::Error::other("Missing installation directory"))?,
    )?
    .sync_all()?;
    #[cfg(not(unix))]
    let _ = target;
    Ok(())
}

pub(super) fn restore_previous(directory: &Path, target: &Path) -> std::io::Result<()> {
    if let Some(bundle) = app_bundle_path(target)
        && directory.join("previous.app").is_dir()
    {
        if bundle.exists() {
            std::fs::remove_dir_all(bundle)?;
        }
        std::fs::rename(directory.join("previous.app"), bundle)?;
        return sync_parent(bundle);
    }
    let previous = directory.join("previous");
    if !previous.is_file() {
        return Err(std::io::Error::other("Missing previous executable"));
    }
    #[cfg(windows)]
    if target.exists() {
        std::fs::remove_file(target)?;
    }
    std::fs::rename(previous, target)?;
    // The original is installed even if the filesystem cannot confirm durability.
    if let Err(error) = sync_parent(target) {
        log::error!("Restored executable; directory sync failed: {error}");
    }
    Ok(())
}

pub(super) fn validate_stage(directory: &Path, target: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(directory)?;
    if !metadata.is_dir()
        || directory.parent() != Some(installation_directory(target)?)
        || !directory
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with(".rcman-update-"))
    {
        return Err(std::io::Error::other("Invalid update directory"));
    }
    Ok(())
}

fn read_plan(directory: &Path, target: Option<&Path>, kind: &str) -> Result<StagedUpdate, String> {
    let plan: StagedUpdate = serde_json::from_slice(
        &std::fs::read(directory.join("plan.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    validate_stage(directory, &plan.target).map_err(|e| e.to_string())?;
    if plan.kind != kind || target.is_some_and(|target| target != plan.target) {
        return Err("Invalid update target or kind".into());
    }
    std::fs::remove_file(directory.join("plan.json")).map_err(|e| e.to_string())?;
    Ok(plan)
}

pub(super) fn stage_lock(directory: &Path) -> std::io::Result<std::fs::File> {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("lock"))?;
    lock.try_lock().map_err(std::io::Error::other)?;
    Ok(lock)
}

fn supervisor_active(directory: &Path, target: &Path) -> bool {
    if validate_stage(directory, target).is_err() {
        return false;
    }
    let Ok(lock) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("lock"))
    else {
        return false;
    };
    matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock))
}

fn prune_completed(target: &Path) {
    let Ok(parent) = installation_directory(target) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let directory = entry.path();
        if validate_stage(&directory, target).is_err() || !directory.join("committed").is_file() {
            continue;
        }
        let matches = std::fs::read(directory.join("target.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<PathBuf>(&b).ok())
            .is_some_and(|p| p == target);
        if !matches {
            continue;
        }
        if let Ok(lock) = stage_lock(&directory) {
            drop(lock);
            let _ = remove_completed(&directory);
        }
    }
}

fn remove_completed(directory: &Path) -> std::io::Result<()> {
    // A running Windows helper cannot delete itself. Keep the completion and
    // target markers intact so the next preparation can identify and prune it.
    #[cfg(windows)]
    if directory.join("updater.exe").exists() {
        std::fs::remove_file(directory.join("updater.exe"))?;
    }
    std::fs::remove_dir_all(directory)
}

/// Runs before CLI/runtime/GUI setup. Never accepts elevated privileges.
pub fn run_helper_if_requested(expected_kind: &str) -> bool {
    #[cfg(windows)]
    super::process_tree::wait_for_assignment();
    let mut args = std::env::args_os().skip(1);
    #[cfg(windows)]
    let flag = "--rcman-update-helper";
    #[cfg(not(windows))]
    let flag = "--rcman-update-supervisor";
    if args.next().as_deref() != Some(std::ffi::OsStr::new(flag)) {
        return false;
    }
    let result = (|| -> Result<i32, String> {
        let directory = PathBuf::from(args.next().ok_or("Missing staged update directory")?)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if args.next().is_some() {
            return Err("Unexpected helper arguments".into());
        }
        #[cfg(windows)]
        let name = "updater.exe";
        #[cfg(not(windows))]
        let name = "previous";
        if std::env::current_exe()
            .map_err(|e| e.to_string())?
            .canonicalize()
            .map_err(|e| e.to_string())?
            != directory.join(name)
        {
            return Err("Invalid helper location".into());
        }
        let initial_lock = stage_lock(&directory).map_err(|e| e.to_string())?;
        let plan = read_plan(&directory, None, expected_kind)?;
        #[cfg(windows)]
        {
            // Open a real parent handle BEFORE acknowledging readiness. PID reuse
            // and slow cleanup cannot make us install over a live parent.
            let parent =
                super::process_tree::Parent::open(plan.parent_pid).map_err(|e| e.to_string())?;
            write_private(&directory.join("helper-ready"), b"").map_err(|e| e.to_string())?;
            parent.wait().map_err(|e| e.to_string())?;
        }
        let result = install_loop(directory.clone(), plan, PUBLIC_KEY);
        drop(initial_lock);
        if result.is_ok() && directory.join("committed").is_file() {
            let _ = remove_completed(&directory);
        }
        result
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Application update failed: {error}");
            std::process::exit(1);
        }
    }
}

fn install_loop(mut directory: PathBuf, mut plan: StagedUpdate, key: &str) -> Result<i32, String> {
    let bootstrap = directory.clone();
    let mut current_version = env!("CARGO_PKG_VERSION").to_owned();
    loop {
        let lock = if directory != bootstrap {
            Some(stage_lock(&directory).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let version = match install_staged(&directory, &plan, &current_version, key) {
            Ok(version) => version,
            Err(error) => return super::supervisor::recover(&directory, &plan, true, &error),
        };
        current_version = version.clone();
        match super::supervisor::run(&directory, &plan, &version)? {
            super::supervisor::Completion::Exit(code) => return Ok(code),
            super::supervisor::Completion::Next(next) => {
                let next_plan = read_plan(&next, Some(&plan.target), &plan.kind)?;
                drop(lock);
                if directory != bootstrap {
                    let _ = remove_completed(&directory);
                }
                directory = next;
                plan = next_plan;
            }
        }
    }
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
#[path = "binary_process_tests.rs"]
mod process_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_bundle_replacement_and_rollback_preserve_settings_and_all_bundle_files() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("Renamed.app");
        let target = bundle.join("Contents/MacOS/rclone-manager");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"old executable").unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), b"old bundle metadata").unwrap();
        std::fs::create_dir(root.path().join("config")).unwrap();
        let settings = root.path().join("config/settings.json");
        std::fs::write(&settings, b"private user settings").unwrap();
        let stage = tempfile::Builder::new()
            .prefix(".rcman-update-")
            .tempdir_in(root.path())
            .unwrap();
        assert_eq!(installation_directory(&target).unwrap(), root.path());
        validate_stage(stage.path(), &target).unwrap();
        preserve_previous(stage.path(), &target).unwrap();
        let manifest = super::super::manifest::test_portable_manifest("macos-aarch64");
        let payload = include_bytes!("fixtures/portable-macos-aarch64-99.0.0.zip");
        let key = include_str!("fixtures/portable-public.key");
        manifest.verify_install_payload(payload, key).unwrap();
        replace_bundle(
            stage.path(),
            &target,
            payload,
            manifest.bundle_root().unwrap(),
            &manifest,
            key,
        )
        .unwrap();
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
        assert_eq!(std::fs::read(&settings).unwrap(), b"private user settings");
        restore_previous(stage.path(), &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"old executable");
        assert_eq!(
            std::fs::read(bundle.join("Contents/Info.plist")).unwrap(),
            b"old bundle metadata"
        );
        assert!(!bundle.join("Contents/_CodeSignature").exists());
        assert_eq!(std::fs::read(&settings).unwrap(), b"private user settings");
    }

    #[cfg(unix)]
    #[test]
    fn preparation_does_not_replace_the_running_executable() {
        use std::os::unix::fs::MetadataExt;
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let before = std::fs::metadata(&executable).unwrap();
        let result = prepare(
            "server",
            b"manifest fixture",
            "signature fixture",
            b"candidate",
        )
        .unwrap();
        let InstallOutcome::RestartBinary {
            previous,
            executable: target,
            ..
        } = result
        else {
            panic!("expected helper restart");
        };
        let stage = previous.parent().unwrap();
        assert_eq!(target, executable);
        assert_eq!(std::fs::metadata(&executable).unwrap().ino(), before.ino());
        assert_eq!(
            std::fs::metadata(previous.clone()).unwrap().ino(),
            before.ino()
        );
        assert_eq!(std::fs::read(stage.join("payload")).unwrap(), b"candidate");
        std::fs::remove_dir_all(stage).unwrap();
    }

    #[test]
    fn replacement_preserves_permissions_configuration_and_backup() {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        let target = root.path().join("App with ' spaces");
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(root.path().join("settings.json"), b"private config").unwrap();
        std::fs::write(stage.path().join("payload"), b"new").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        }
        let permissions = std::fs::metadata(&target).unwrap().permissions();
        preserve_previous(stage.path(), &target).unwrap();
        replace_verified(stage.path(), &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(
            std::fs::read(stage.path().join("previous")).unwrap(),
            b"old"
        );
        assert_eq!(
            std::fs::read(root.path().join("settings.json")).unwrap(),
            b"private config"
        );
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions(),
            permissions
        );
        assert!(replace_verified(stage.path(), &target).is_err());
    }
    #[test]
    fn failed_preparation_leaves_current_executable_untouched() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("app");
        std::fs::write(&target, b"old").unwrap();
        assert!(replace_verified(root.path(), &target).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"old");
        assert!(!root.path().join("previous").exists());
    }

    #[test]
    fn rollback_moves_the_existing_backup_without_copying_user_data() {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        let target = root.path().join("app");
        std::fs::write(&target, b"broken new version").unwrap();
        std::fs::write(stage.path().join("previous"), b"old version").unwrap();
        std::fs::write(root.path().join("settings.json"), b"user settings").unwrap();
        restore_previous(stage.path(), &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"old version");
        assert!(!stage.path().join("previous").exists());
        assert_eq!(
            std::fs::read(root.path().join("settings.json")).unwrap(),
            b"user settings"
        );
        assert!(restore_previous(stage.path(), &target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"old version");
    }

    #[test]
    fn post_rename_sync_failure_can_restore_the_original_without_copying() {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        let target = root.path().join("app");
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(stage.path().join("payload"), b"new").unwrap();
        preserve_previous(stage.path(), &target).unwrap();
        #[cfg(unix)]
        let old_inode = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&target).unwrap().ino()
        };
        let result = replace_with_sync(stage.path(), &target, |_| {
            Err(std::io::Error::other("injected sync failure"))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        restore_previous(stage.path(), &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::metadata(&target).unwrap().ino(), old_inode);
        }
    }

    #[test]
    fn pruning_keeps_active_failed_and_unrelated_updates() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("app");
        let stages: Vec<_> = (0..4)
            .map(|_| {
                tempfile::Builder::new()
                    .prefix(".rcman-update-")
                    .tempdir_in(root.path())
                    .unwrap()
            })
            .collect();
        for (index, stage) in stages.iter().enumerate() {
            write_private(
                &stage.path().join("target.json"),
                &serde_json::to_vec(if index == 3 { root.path() } else { &target }).unwrap(),
            )
            .unwrap();
            if index != 2 {
                write_private(&stage.path().join("committed"), b"1.2.3").unwrap();
            }
        }
        let active = stage_lock(stages[1].path()).unwrap();
        assert!(supervisor_active(stages[1].path(), &target));
        assert!(!supervisor_active(stages[0].path(), &target));
        prune_completed(&target);
        assert!(!stages[0].path().exists());
        for stage in &stages[1..] {
            assert!(stage.path().exists());
        }
        drop(active);
        assert!(!supervisor_active(stages[1].path(), &target));
        prune_completed(&target);
        assert!(!stages[1].path().exists());
    }

    #[cfg(windows)]
    #[test]
    fn locked_helper_retains_cleanup_markers_until_a_later_attempt() {
        use std::os::windows::fs::OpenOptionsExt;
        let stage = tempfile::tempdir().unwrap();
        std::fs::write(stage.path().join("updater.exe"), b"helper").unwrap();
        std::fs::write(stage.path().join("committed"), b"version").unwrap();
        std::fs::write(stage.path().join("target.json"), b"target").unwrap();
        let running = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(stage.path().join("updater.exe"))
            .unwrap();
        assert!(remove_completed(stage.path()).is_err());
        assert!(stage.path().join("committed").is_file());
        assert!(stage.path().join("target.json").is_file());
        drop(running);
        remove_completed(stage.path()).unwrap();
        assert!(!stage.path().exists());
    }

    #[test]
    fn handoff_plan_must_match_the_existing_target_and_product() {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::Builder::new()
            .prefix(".rcman-update-")
            .tempdir_in(root.path())
            .unwrap();
        let target = root.path().join("app");
        let plan = StagedUpdate {
            kind: "server".into(),
            target: target.clone(),
            args: vec![],
            working_directory: root.path().into(),
            parent_pid: 1,
        };
        write_private(
            &stage.path().join("plan.json"),
            &serde_json::to_vec(&plan).unwrap(),
        )
        .unwrap();
        assert!(read_plan(stage.path(), Some(&root.path().join("other")), "server").is_err());
        assert!(read_plan(stage.path(), Some(&target), "portable").is_err());
        assert_eq!(
            read_plan(stage.path(), Some(&target), "server")
                .unwrap()
                .target,
            target
        );
        assert!(!stage.path().join("plan.json").exists());
    }
}
