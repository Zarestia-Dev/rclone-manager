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
        // Never write to an arbitrary directory supplied by an environment variable.
        if directory.parent() != executable.parent()
            || !directory
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".rcman-update-"))
        {
            return Err("Invalid update health directory".into());
        }
        write_receipt(&directory, &token, env!("CARGO_PKG_VERSION"))?;
        Ok(())
    })();
    if let Err(error) = result {
        log::error!("Could not confirm updated application startup: {error}");
    }
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
