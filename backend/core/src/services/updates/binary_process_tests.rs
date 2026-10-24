//! Signed shell fixtures exercise replacement and supervision in a child process.
use super::*;
use std::{os::unix::fs::PermissionsExt, process::Child, time::Duration};

const KEY: &str = include_str!("fixtures/process-public.key");
const PAYLOAD: &[u8] = include_bytes!("fixtures/process-app.sh");
const ORIGINAL: &[u8] = b"#!/bin/sh\nprintf recovered > \"$4\"\n";

fn stage(root: &Path, target: &Path, mode: &str, version: &str, next: &Path) -> PathBuf {
    let directory = tempfile::Builder::new()
        .prefix(".rcman-update-")
        .tempdir_in(root)
        .unwrap()
        .keep();
    let (manifest, signature) = match version {
        "99.0.0" => (
            include_bytes!("fixtures/process-99.0.0.json").as_slice(),
            include_bytes!("fixtures/process-99.0.0.json.sig").as_slice(),
        ),
        "99.0.1" => (
            include_bytes!("fixtures/process-99.0.1.json").as_slice(),
            include_bytes!("fixtures/process-99.0.1.json.sig").as_slice(),
        ),
        _ => panic!("Unknown fixture version"),
    };
    for (name, bytes) in [
        ("manifest.json", manifest),
        ("manifest.sig", signature),
        ("payload", PAYLOAD),
    ] {
        write_private(&directory.join(name), bytes).unwrap();
    }
    let plan = StagedUpdate {
        kind: "portable".into(),
        target: target.to_owned(),
        args: vec![
            mode.into(),
            version.into(),
            next.as_os_str().to_owned(),
            root.join("recovered").into_os_string(),
        ],
        working_directory: root.to_owned(),
        parent_pid: 0,
        log_directory: Some(root.join("logs")),
    };
    write_private(
        &directory.join("plan.json"),
        &serde_json::to_vec(&plan).unwrap(),
    )
    .unwrap();
    write_private(
        &directory.join("path.json"),
        &serde_json::to_vec(&directory).unwrap(),
    )
    .unwrap();
    directory
}

fn original(root: &Path) -> PathBuf {
    let target = root.join("app with ' spaces");
    std::fs::write(&target, ORIGINAL).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
    target
}

fn launch(directory: &Path) -> Child {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "services::updates::binary::process_tests::helper_fixture",
            "--nocapture",
        ])
        .env("RCMAN_SIGNED_PROCESS_FIXTURE", directory)
        .spawn()
        .unwrap()
}

fn wait_for_exit(child: &mut Child) {
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "Helper failed: {status}");
            return;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Helper did not finish before the test deadline");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn helper_fixture() {
    let Some(directory) = std::env::var_os("RCMAN_SIGNED_PROCESS_FIXTURE") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let _lock = stage_lock(&directory).unwrap();
    let plan = read_plan(&directory, None, "portable").unwrap();
    crate::utils::logging::log::init_helper_logging(plan.log_directory.as_deref()).unwrap();
    // Production entry points always pass PUBLIC_KEY. Only this test process
    // trusts the disposable fixture key; no runtime key override is exposed.
    std::process::exit(install_loop(directory, plan, KEY).unwrap());
}

#[test]
fn signed_update_replaces_the_binary_and_commits_after_startup_confirmation() {
    let root = tempfile::tempdir().unwrap();
    let target = original(root.path());
    let directory = stage(root.path(), &target, "ready", "99.0.0", root.path());
    preserve_previous(&directory, &target).unwrap();
    wait_for_exit(&mut launch(&directory));
    assert_eq!(std::fs::read(&target).unwrap(), PAYLOAD);
    assert_eq!(
        std::fs::read(directory.join("committed")).unwrap(),
        b"99.0.0"
    );
    assert!(!directory.join("previous").exists());
    assert!(!root.path().join("recovered").exists());
    let logs = std::fs::read_to_string(root.path().join("logs/rclone-manager.log")).unwrap();
    for message in [
        "Installing verified update",
        "Installed executable verified",
        "Startup receipt verified",
        "Update committed",
    ] {
        assert!(logs.contains(message), "Missing helper log: {message}");
    }
}

#[test]
fn signed_update_that_crashes_restores_and_relaunches_the_original() {
    let root = tempfile::tempdir().unwrap();
    let target = original(root.path());
    let directory = stage(root.path(), &target, "crash", "99.0.0", root.path());
    preserve_previous(&directory, &target).unwrap();
    wait_for_exit(&mut launch(&directory));
    assert_eq!(std::fs::read(&target).unwrap(), ORIGINAL);
    assert!(root.path().join("recovered").is_file());
    assert!(directory.join("failure.txt").is_file());
    assert!(!directory.join("committed").exists());
    let logs = std::fs::read_to_string(root.path().join("logs/rclone-manager.log")).unwrap();
    assert!(logs.contains("Rolling back update"));
    assert!(logs.contains("Previous executable restored"));
}

#[test]
fn tampered_payload_is_rejected_before_starting_the_candidate() {
    let root = tempfile::tempdir().unwrap();
    let target = original(root.path());
    let directory = stage(root.path(), &target, "ready", "99.0.0", root.path());
    preserve_previous(&directory, &target).unwrap();
    std::fs::write(directory.join("payload"), b"tampered executable").unwrap();
    wait_for_exit(&mut launch(&directory));
    assert_eq!(std::fs::read(&target).unwrap(), ORIGINAL);
    assert!(root.path().join("recovered").is_file());
    assert!(!directory.join("ready.json").exists());
}

#[test]
fn production_key_rejects_the_process_fixture_before_replacement() {
    let root = tempfile::tempdir().unwrap();
    let target = original(root.path());
    let directory = stage(root.path(), &target, "ready", "99.0.0", root.path());
    assert!(read_manifest(&directory, "portable", PUBLIC_KEY).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), ORIGINAL);
}

#[test]
fn consecutive_signed_updates_use_one_supervisor_and_validate_both_stages() {
    let root = tempfile::tempdir().unwrap();
    let target = original(root.path());
    let second = stage(root.path(), &target, "ready", "99.0.1", root.path());
    let first = stage(root.path(), &target, "handoff", "99.0.0", &second);
    preserve_previous(&first, &target).unwrap();
    wait_for_exit(&mut launch(&first));
    assert_eq!(std::fs::read(&target).unwrap(), PAYLOAD);
    assert_eq!(std::fs::read(first.join("committed")).unwrap(), b"99.0.0");
    assert_eq!(std::fs::read(second.join("committed")).unwrap(), b"99.0.1");
    assert!(!second.join("plan.json").exists());
    assert!(!root.path().join("recovered").exists());
}

#[test]
fn administrative_stop_keeps_a_committed_signed_update() {
    let root = tempfile::tempdir().unwrap();
    let target = original(root.path());
    let directory = stage(root.path(), &target, "wait", "99.0.0", root.path());
    preserve_previous(&directory, &target).unwrap();
    let mut child = launch(&directory);
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !directory.join("committed").exists() {
        if child.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Updated process did not commit");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let stopped = std::time::Instant::now();
    assert_eq!(
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) },
        0
    );
    wait_for_exit(&mut child);
    assert!(stopped.elapsed() < Duration::from_secs(15));
    assert_eq!(std::fs::read(&target).unwrap(), PAYLOAD);
    assert!(!root.path().join("recovered").exists());
}
