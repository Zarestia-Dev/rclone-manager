//! Keep the original Unix service PID while supervising the updated child.
//! This helper never accepts elevated privileges or an HTTP installation command.
use super::{binary::StagedUpdate, health};
use std::{path::Path, time::Duration};

const STARTUP_DEADLINE: Duration = Duration::from_secs(90);
const STABILITY_WINDOW: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Completion {
    Exit(i32),
    Next(std::path::PathBuf),
}

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Exit(i32),
    Next(std::path::PathBuf),
    Rollback { restart: bool, reason: String },
}

#[derive(Default)]
struct Trial {
    ready_since: Option<Duration>,
    committed: bool,
}

impl Trial {
    fn observe(&mut self, elapsed: Duration, ready: bool, stability: Duration) -> bool {
        if self.committed {
            return false;
        }
        if ready {
            let since = *self.ready_since.get_or_insert(elapsed);
            if elapsed.saturating_sub(since) >= stability {
                self.committed = true;
                return true;
            }
        } else {
            self.ready_since = None;
        }
        false
    }

    fn exited(&self, code: i32) -> Decision {
        if self.committed {
            Decision::Exit(code)
        } else {
            Decision::Rollback {
                // A normal close is respected; don't reopen a deliberately closed app.
                restart: code != 0,
                reason: format!("Updated application exited before startup confirmation ({code})"),
            }
        }
    }
}

pub(super) fn run(
    directory: &Path,
    plan: &StagedUpdate,
    version: &str,
) -> Result<Completion, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let decision = runtime.block_on(async {
        // Register signals before spawning so an administrative stop is never
        // interpreted as a failed update followed by an unwanted restart.
        #[cfg(unix)]
        let stop = {
            use tokio::signal::unix::{SignalKind, signal};
            let mut terminate = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
            let mut interrupt = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
            async move {
                tokio::select! {
                    _ = terminate.recv() => libc::SIGTERM,
                    _ = interrupt.recv() => libc::SIGINT,
                }
            }
        };
        #[cfg(not(unix))]
        let stop = async {
            match tokio::signal::ctrl_c().await {
                Ok(()) => 0,
                // A GUI helper may have no console. Failure to subscribe must
                // not look like a user requested shutdown.
                Err(_) => std::future::pending().await,
            }
        };
        let token = uuid::Uuid::new_v4().to_string();
        let mut command = tokio::process::Command::new(&plan.target);
        command
            .args(&plan.args)
            .current_dir(&plan.working_directory)
            .env(health::DIRECTORY_ENV, directory)
            .env(health::TOKEN_ENV, &token)
            .kill_on_drop(true);
        super::process_tree::configure(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return Ok(Decision::Rollback {
                    restart: true,
                    reason: format!("Updated application could not start: {error}"),
                });
            }
        };
        match monitor(
            &mut child,
            directory,
            &token,
            version,
            stop,
            STARTUP_DEADLINE,
            STABILITY_WINDOW,
        )
        .await
        {
            Ok(decision) => Ok(decision),
            Err(error) => {
                let _ = child.kill().await;
                Ok(Decision::Rollback {
                    restart: true,
                    reason: error,
                })
            }
        }
    });
    match decision.unwrap_or_else(|reason| Decision::Rollback {
        restart: true,
        reason,
    }) {
        Decision::Next(next) => {
            super::binary::validate_stage(&next, &plan.target).map_err(|e| e.to_string())?;
            Ok(Completion::Next(next))
        }
        Decision::Exit(code) => Ok(Completion::Exit(code)),
        Decision::Rollback { restart, reason } => {
            recover(directory, plan, restart, &reason).map(Completion::Exit)
        }
    }
}

pub(super) fn recover(
    directory: &Path,
    plan: &StagedUpdate,
    restart: bool,
    reason: &str,
) -> Result<i32, String> {
    let _ = std::fs::write(directory.join("failure.txt"), reason);
    super::binary::restore_previous(directory, &plan.target)
        .map_err(|e| format!("{reason}; restoring previous executable failed: {e}"))?;
    if !restart {
        return Ok(0);
    }
    let mut command = std::process::Command::new(&plan.target);
    command
        .args(&plan.args)
        .current_dir(&plan.working_directory)
        .env_remove(health::DIRECTORY_ENV)
        .env_remove(health::TOKEN_ENV);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(format!(
            "{reason}; restarting previous version failed: {}",
            command.exec()
        ))
    }
    #[cfg(not(unix))]
    {
        command
            .spawn()
            .map_err(|e| format!("{reason}; restarting previous version failed: {e}"))?;
        Ok(0)
    }
}

async fn monitor(
    child: &mut tokio::process::Child,
    directory: &Path,
    token: &str,
    version: &str,
    stop: impl std::future::Future<Output = i32>,
    deadline: Duration,
    stability: Duration,
) -> Result<Decision, String> {
    let mut tree = super::process_tree::ProcessTree::attach(child).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    super::process_tree::release_child(child)
        .await
        .map_err(|e| e.to_string())?;
    let started = tokio::time::Instant::now();
    let mut trial = Trial::default();
    tokio::pin!(stop);
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            biased;
            signal = &mut stop => {
                stop_child(child, &tree, signal).await?;
                return Ok(if trial.committed { Decision::Exit(0) } else {
                    Decision::Rollback { restart: false, reason: "Update startup interrupted by shutdown".into() }
                });
            }
            status = child.wait() => {
                let status = status.map_err(|e| e.to_string())?;
                let code = status.code().unwrap_or(1);
                if trial.committed && code == 0 {
                    match std::fs::read(directory.join("next.json")) {
                        Ok(bytes) => return serde_json::from_slice(&bytes).map(Decision::Next).map_err(|e| e.to_string()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            // Ordinary platform restarts can spawn a replacement child.
                            // Preserve it after a committed, clean exit; update handoffs
                            // and administrative stops still clean the entire trial tree.
                            tree.disarm().map_err(|e| e.to_string())?;
                        },
                        Err(error) => return Err(error.to_string()),
                    }
                }
                return Ok(trial.exited(code));
            }
            _ = tick.tick(), if !trial.committed => {
                let elapsed = started.elapsed();
                if trial.observe(elapsed, health::confirmed(directory, token, version), stability) {
                    super::binary::write_private(&directory.join("committed"), version.as_bytes())
                        .map_err(|e| e.to_string())?;
                    // Rollback is no longer possible after commitment.
                    if let Err(error) = std::fs::remove_file(directory.join("previous"))
                        && error.kind() != std::io::ErrorKind::NotFound { log::warn!("Could not remove committed backup: {error}"); }
                    if let Err(error) = std::fs::remove_dir_all(directory.join("previous.app"))
                        && error.kind() != std::io::ErrorKind::NotFound { log::warn!("Could not remove committed app bundle backup: {error}"); }
                }
                if !trial.committed && trial.ready_since.is_none() && elapsed >= deadline {
                    // Kill the isolated trial tree before restoring and reopening the old build.
                    tree.terminate().map_err(|e| e.to_string())?;
                    child.wait().await.map_err(|e| e.to_string())?;
                    return Ok(Decision::Rollback {
                        restart: true,
                        reason: "Updated application did not confirm startup before the deadline".into(),
                    });
                }
            }
        }
    }
}

async fn stop_child(
    child: &mut tokio::process::Child,
    tree: &super::process_tree::ProcessTree,
    signal: i32,
) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // Child is still unreaped, so this PID cannot have been reused.
        unsafe { libc::kill(pid as libc::pid_t, signal) };
    }
    #[cfg(not(unix))]
    {
        let _ = signal;
        child.start_kill().map_err(|e| e.to_string())?;
    }
    match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
        Ok(result) => {
            result.map_err(|e| e.to_string())?;
        }
        Err(_) => {
            tree.terminate().map_err(|e| e.to_string())?;
            child.wait().await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_must_remain_valid_through_the_stability_window() {
        let mut trial = Trial::default();
        assert!(!trial.observe(Duration::ZERO, false, STABILITY_WINDOW));
        assert!(!trial.observe(Duration::from_secs(1), true, STABILITY_WINDOW));
        assert!(!trial.observe(Duration::from_secs(5), false, STABILITY_WINDOW));
        assert!(!trial.observe(Duration::from_secs(6), true, STABILITY_WINDOW));
        assert!(!trial.observe(Duration::from_secs(15), true, STABILITY_WINDOW));
        assert!(trial.observe(Duration::from_secs(16), true, STABILITY_WINDOW));
        assert!(!trial.observe(Duration::from_secs(17), true, STABILITY_WINDOW));
        assert_eq!(trial.exited(5), Decision::Exit(5));
    }

    #[test]
    fn early_exits_restore_but_only_failures_reopen_the_app() {
        let trial = Trial::default();
        assert!(matches!(
            trial.exited(1),
            Decision::Rollback { restart: true, .. }
        ));
        assert!(matches!(
            trial.exited(0),
            Decision::Rollback { restart: false, .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn actual_crashed_child_requests_rollback() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .unwrap();
        let decision = monitor(
            &mut child,
            directory.path(),
            "token",
            "1.2.3",
            std::future::pending(),
            STARTUP_DEADLINE,
            STABILITY_WINDOW,
        )
        .await
        .unwrap();
        assert!(matches!(decision, Decision::Rollback { restart: true, .. }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn administrative_stop_does_not_restart_a_trial() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .unwrap();
        let decision = monitor(
            &mut child,
            directory.path(),
            "token",
            "1.2.3",
            async { libc::SIGTERM },
            STARTUP_DEADLINE,
            STABILITY_WINDOW,
        )
        .await
        .unwrap();
        assert!(matches!(
            decision,
            Decision::Rollback { restart: false, .. }
        ));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_or_stale_receipt_times_out_and_reaps_the_child() {
        for receipt in [None, Some(r#"{"token":"stale","version":"1.2.3"}"#)] {
            let directory = tempfile::tempdir().unwrap();
            if let Some(receipt) = receipt {
                std::fs::write(directory.path().join("ready.json"), receipt).unwrap();
            }
            let mut child = tokio::process::Command::new("/bin/sleep")
                .arg("60")
                .kill_on_drop(true)
                .process_group(0)
                .spawn()
                .unwrap();
            let decision = monitor(
                &mut child,
                directory.path(),
                "token",
                "1.2.3",
                std::future::pending(),
                Duration::from_millis(100),
                Duration::ZERO,
            )
            .await
            .unwrap();
            assert!(matches!(decision, Decision::Rollback { restart: true, .. }));
            assert!(child.try_wait().unwrap().is_some());
            assert!(!directory.path().join("committed").exists());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn healthy_child_commits_and_later_shutdown_keeps_the_update() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("ready.json"),
            r#"{"token":"token","version":"1.2.3"}"#,
        )
        .unwrap();
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .unwrap();
        let decision = monitor(
            &mut child,
            directory.path(),
            "token",
            "1.2.3",
            async {
                tokio::time::sleep(Duration::from_millis(250)).await;
                libc::SIGTERM
            },
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .unwrap();
        assert_eq!(decision, Decision::Exit(0));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("committed")).unwrap(),
            "1.2.3"
        );
        assert!(child.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_descendants_before_rollback() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("activity");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args([
                "-c",
                "(while :; do printf x >> \"$1\"; sleep 0.02; done) & wait",
                "trial",
            ])
            .arg(&marker)
            .kill_on_drop(true);
        super::super::process_tree::configure(&mut command);
        let mut child = command.spawn().unwrap();
        let decision = monitor(
            &mut child,
            directory.path(),
            "token",
            "1.2.3",
            std::future::pending(),
            Duration::from_millis(200),
            Duration::ZERO,
        )
        .await
        .unwrap();
        assert!(matches!(decision, Decision::Rollback { restart: true, .. }));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let length = std::fs::metadata(&marker).unwrap().len();
        assert!(length > 0);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(std::fs::metadata(marker).unwrap().len(), length);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn committed_exit_hands_off_but_administrative_stop_does_not() {
        for administrative_stop in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let next = directory.path().join("next-stage");
            std::fs::write(
                directory.path().join("next.json"),
                serde_json::to_vec(&next).unwrap(),
            )
            .unwrap();
            std::fs::write(directory.path().join("previous"), b"old").unwrap();
            std::fs::write(
                directory.path().join("ready.json"),
                r#"{"token":"token","version":"1.2.3"}"#,
            )
            .unwrap();
            let mut child = tokio::process::Command::new("/bin/sleep")
                .arg(if administrative_stop { "60" } else { "0.3" })
                .process_group(0)
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let stop = async {
                if !administrative_stop {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                libc::SIGTERM
            };
            let result = monitor(
                &mut child,
                directory.path(),
                "token",
                "1.2.3",
                stop,
                Duration::from_secs(2),
                Duration::ZERO,
            )
            .await
            .unwrap();
            assert_eq!(
                result,
                if administrative_stop {
                    Decision::Exit(0)
                } else {
                    Decision::Next(next)
                }
            );
            assert!(!directory.path().join("previous").exists());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn committed_normal_restart_preserves_a_replacement_process() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("activity");
        std::fs::write(
            directory.path().join("ready.json"),
            r#"{"token":"token","version":"1.2.3"}"#,
        )
        .unwrap();
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args([
                "-c",
                "(while :; do printf x >> \"$1\"; sleep 0.02; done) & sleep 0.3; exit 0",
                "restart",
            ])
            .arg(&marker)
            .kill_on_drop(true);
        super::super::process_tree::configure(&mut command);
        let mut child = command.spawn().unwrap();
        // Independent test guard cleans up the intentionally surviving replacement.
        let _cleanup = super::super::process_tree::ProcessTree::attach(&child).unwrap();
        let decision = monitor(
            &mut child,
            directory.path(),
            "token",
            "1.2.3",
            std::future::pending(),
            Duration::from_secs(2),
            Duration::ZERO,
        )
        .await
        .unwrap();
        assert_eq!(decision, Decision::Exit(0));
        let before = std::fs::metadata(&marker).unwrap().len();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(std::fs::metadata(marker).unwrap().len() > before);
    }

    // Run the exec-based recovery in a separate test process, never the runner.
    #[cfg(unix)]
    #[test]
    fn recovery_process_fixture() {
        let Some(directory) = std::env::var_os("RCMAN_TEST_RECOVERY_DIRECTORY") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        let plan: StagedUpdate =
            serde_json::from_slice(&std::fs::read(directory.join("plan.json")).unwrap()).unwrap();
        match run(&directory, &plan, "1.2.3").unwrap() {
            Completion::Exit(code) => std::process::exit(code),
            Completion::Next(_) => panic!("unexpected handoff"),
        };
    }

    #[cfg(unix)]
    #[test]
    fn failed_update_restores_and_executes_previous_with_original_arguments_and_cwd() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        let target = root.path().join("app with ' spaces");
        let previous = stage.path().join("previous");
        let marker = root.path().join("recovered.txt");
        let previous_bytes = b"#!/bin/sh\nprintf '%s\\n' \"$1\" > \"$2\"\npwd >> \"$2\"\n";
        std::fs::write(&previous, previous_bytes).unwrap();
        std::fs::write(&target, b"#!/bin/sh\nexit 7\n").unwrap();
        for file in [&target, &previous] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o750)).unwrap();
        }
        let arguments: Vec<std::ffi::OsString> = vec![
            "argument with ' spaces".into(),
            marker.as_os_str().to_owned(),
        ];
        std::fs::write(
            stage.path().join("plan.json"),
            serde_json::to_vec(&serde_json::json!({
                "kind": "server", "target": target, "args": arguments,
                "working_directory": root.path(),
            }))
            .unwrap(),
        )
        .unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "services::updates::supervisor::tests::recovery_process_fixture",
                "--nocapture",
            ])
            .env("RCMAN_TEST_RECOVERY_DIRECTORY", stage.path())
            .current_dir(root.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read(&target).unwrap(), previous_bytes);
        assert_eq!(
            std::fs::read_to_string(marker).unwrap(),
            format!(
                "argument with ' spaces\n{}\n",
                root.path().canonicalize().unwrap().display()
            )
        );
        assert!(stage.path().join("failure.txt").is_file());
    }
}
