//! A private startup receipt, separate from Rclone connectivity and vault unlock.
use crate::context::AppHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) const DIRECTORY_ENV: &str = "RCMAN_UPDATE_HEALTH_DIRECTORY";
pub(super) const TOKEN_ENV: &str = "RCMAN_UPDATE_HEALTH_TOKEN";

#[derive(Default)]
pub struct StartupHealth {
    core: AtomicBool,
    host: AtomicBool,
    needs_frontend: AtomicBool,
    frontend: AtomicBool,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    token: String,
    version: String,
}

impl StartupHealth {
    fn ready(&self) -> bool {
        self.core.load(Ordering::SeqCst)
            && self.host.load(Ordering::SeqCst)
            && (!self.needs_frontend.load(Ordering::SeqCst) || self.frontend.load(Ordering::SeqCst))
    }
}

/// Required local initialization succeeded (or the locked-vault entry is ready).
/// External connections and vault unlock intentionally do not gate this check.
pub fn core_ready(app: &AppHandle) {
    let health = app.state::<StartupHealth>();
    health.core.store(true, Ordering::SeqCst);
    report_if_ready(&health);
}

/// Called only after the native event loop or the actual HTTP listener is ready.
pub fn host_ready(app: &AppHandle) {
    let health = app.state::<StartupHealth>();
    health.host.store(true, Ordering::SeqCst);
    report_if_ready(&health);
}

/// The portable host enables this only when it creates a main webview. Tray-only
/// launches must not depend on a window the user did not request.
pub fn require_frontend(app: &AppHandle) {
    app.state::<StartupHealth>()
        .needs_frontend
        .store(true, Ordering::SeqCst);
}

/// Called after Angular's first completed render, including the locked-vault UI.
pub async fn confirm_frontend_ready(app: AppHandle) {
    let health = app.state::<StartupHealth>();
    health.frontend.store(true, Ordering::SeqCst);
    report_if_ready(&health);
}

fn report_if_ready(health: &StartupHealth) {
    if !health.ready() {
        return;
    }
    let Some(directory) = std::env::var_os(DIRECTORY_ENV).map(PathBuf::from) else {
        return;
    };
    let Ok(token) = std::env::var(TOKEN_ENV) else {
        return;
    };
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let executable = std::env::current_exe()?.canonicalize()?;
        let directory = directory.canonicalize()?;
        confirm_startup(&directory, &executable, &token, env!("CARGO_PKG_VERSION"))?;
        Ok(())
    })();
    if let Err(error) = result {
        log::error!("Could not confirm updated application startup: {error}");
    }
}

fn confirm_startup(
    directory: &Path,
    executable: &Path,
    token: &str,
    version: &str,
) -> std::io::Result<()> {
    // Share the helper's path checks before writing to an environment-supplied directory.
    super::binary::validate_stage(directory, executable)?;
    write_receipt(directory, token, version)
}

fn write_receipt(directory: &Path, token: &str, version: &str) -> std::io::Result<()> {
    use std::io::Write;
    let bytes = serde_json::to_vec(&Receipt {
        token: token.to_owned(),
        version: version.to_owned(),
    })?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(directory.join("ready.json"))
        .map_err(|error| error.error)?;
    Ok(())
}

pub(super) fn confirmed(directory: &Path, token: &str, version: &str) -> bool {
    use std::io::Read;
    let result = (|| -> std::io::Result<Receipt> {
        let path = directory.join("ready.json");
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.len() > 1024 {
            return Err(std::io::Error::other("Invalid health receipt"));
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(1025)
            .read_to_end(&mut bytes)?;
        Ok(serde_json::from_slice(&bytes)?)
    })();
    result.is_ok_and(|receipt| receipt.token == token && receipt.version == version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_receipts_use_the_same_staging_directory_as_the_installer() {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::Builder::new()
            .prefix(".rcman-update-")
            .tempdir_in(root.path())
            .unwrap();
        for member in ["app", "Renamed.app/Contents/MacOS/rclone-manager"] {
            let executable = root.path().join(member);
            confirm_startup(stage.path(), &executable, "attempt", "1.2.3").unwrap();
            assert!(confirmed(stage.path(), "attempt", "1.2.3"));
            std::fs::remove_file(stage.path().join("ready.json")).unwrap();
        }
        let bundle_binary = root
            .path()
            .join("Renamed.app/Contents/MacOS/rclone-manager");
        std::fs::create_dir_all(bundle_binary.parent().unwrap()).unwrap();
        let inside_bundle = tempfile::Builder::new()
            .prefix(".rcman-update-")
            .tempdir_in(bundle_binary.parent().unwrap())
            .unwrap();
        assert!(confirm_startup(inside_bundle.path(), &bundle_binary, "attempt", "1.2.3").is_err());
        let unrelated = tempfile::tempdir().unwrap();
        assert!(confirm_startup(unrelated.path(), &bundle_binary, "attempt", "1.2.3").is_err());
        assert!(!inside_bundle.path().join("ready.json").exists());
        assert!(!unrelated.path().join("ready.json").exists());
    }

    #[test]
    fn receipt_requires_the_current_attempt_and_exact_build_version() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!confirmed(directory.path(), "attempt-1", "1.2.3"));
        write_receipt(directory.path(), "attempt-1", "1.2.3").unwrap();
        assert!(confirmed(directory.path(), "attempt-1", "1.2.3"));
        assert!(!confirmed(directory.path(), "attempt-2", "1.2.3"));
        assert!(!confirmed(directory.path(), "attempt-1", "1.2.4"));
        std::fs::write(directory.path().join("ready.json"), b"invalid").unwrap();
        assert!(!confirmed(directory.path(), "attempt-1", "1.2.3"));
        std::fs::write(directory.path().join("ready.json"), vec![b' '; 1025]).unwrap();
        assert!(!confirmed(directory.path(), "attempt-1", "1.2.3"));
    }

    #[test]
    fn readiness_requires_both_core_and_host_in_either_order() {
        for core_first in [true, false] {
            let app = AppHandle::default();
            app.manage(StartupHealth::default());
            let health = app.state::<StartupHealth>();
            if core_first {
                core_ready(&app);
                assert!(!health.host.load(Ordering::SeqCst));
                host_ready(&app);
            } else {
                host_ready(&app);
                assert!(!health.core.load(Ordering::SeqCst));
                core_ready(&app);
            }
            assert!(health.core.load(Ordering::SeqCst));
            assert!(health.host.load(Ordering::SeqCst));
            assert!(health.ready());
        }
    }

    #[tokio::test]
    async fn render_and_listener_cannot_confirm_failed_or_pending_core_startup() {
        let app = AppHandle::default();
        app.manage(StartupHealth::default());
        require_frontend(&app);
        host_ready(&app);
        confirm_frontend_ready(app.clone()).await;
        assert!(!app.state::<StartupHealth>().ready());
        core_ready(&app);
        assert!(app.state::<StartupHealth>().ready());
    }

    #[tokio::test]
    async fn a_visible_portable_window_requires_a_rendered_frontend() {
        let app = AppHandle::default();
        app.manage(StartupHealth::default());
        require_frontend(&app);
        core_ready(&app);
        host_ready(&app);
        assert!(!app.state::<StartupHealth>().ready());
        confirm_frontend_ready(app.clone()).await;
        assert!(app.state::<StartupHealth>().ready());
    }
}
