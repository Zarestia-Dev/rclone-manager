pub const APP_ID: &str = "io.github.zarestia_dev.rclone-manager";
pub const APP_ID_DEV: &str = "io.github.zarestia_dev.rclone-manager-dev";

#[must_use]
pub fn get_build_type() -> Option<&'static str> {
    // Keep the existing command/wire values for frontend compatibility. This is
    // installation metadata, independent of the web-server runtime feature.
    installation_type(
        cfg!(feature = "flatpak"),
        cfg!(feature = "portable"),
        std::env::var("RCLONE_MANAGER_INSTALLATION_TYPE")
            .ok()
            .as_deref(),
    )
}

fn installation_type(
    flatpak: bool,
    portable: bool,
    deployment: Option<&str>,
) -> Option<&'static str> {
    if flatpak {
        Some("flatpak")
    } else if portable {
        Some("portable")
    } else if deployment.is_some_and(|value| value.trim().eq_ignore_ascii_case("docker")) {
        Some("container")
    } else {
        None
    }
}

#[must_use]
pub fn is_librclone() -> bool {
    cfg!(feature = "librclone")
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActiveOperationsSummary {
    pub has_active_operations: bool,
    pub active_jobs_count: usize,
    pub active_mounts_count: usize,
    pub active_serves_count: usize,
}

static PENDING_APP_EXIT_SUMMARY: std::sync::LazyLock<
    parking_lot::Mutex<Option<ActiveOperationsSummary>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));

pub fn set_pending_app_exit_summary(summary: ActiveOperationsSummary) {
    *PENDING_APP_EXIT_SUMMARY.lock() = Some(summary);
}

#[must_use]
pub fn check_pending_app_exit() -> Option<ActiveOperationsSummary> {
    PENDING_APP_EXIT_SUMMARY.lock().take()
}

pub async fn get_active_operations_summary(
    app: crate::context::AppHandle,
) -> Result<ActiveOperationsSummary, String> {
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();

    let (active_jobs_count, active_mounts_count, active_serves_count) =
        backend_manager.active_operation_counts().await;

    let has_active_operations =
        active_jobs_count > 0 || active_mounts_count > 0 || active_serves_count > 0;

    Ok(ActiveOperationsSummary {
        has_active_operations,
        active_jobs_count,
        active_mounts_count,
        active_serves_count,
    })
}

pub async fn request_app_exit(app: crate::context::AppHandle) -> Result<(), String> {
    let summary = get_active_operations_summary(app.clone()).await?;
    if summary.has_active_operations
        && app.host().confirm_exit(summary) == crate::context::ExitDecision::Deferred
    {
        return Ok(());
    }

    crate::services::lifecycle::shutdown::handle_shutdown(app.clone()).await;
    app.exit(0);

    Ok(())
}

pub async fn relaunch_app(app: crate::context::AppHandle) -> Result<(), String> {
    use crate::services::lifecycle::shutdown::handle_shutdown;
    handle_shutdown(app.clone()).await;
    app.host().restart(&app)
}

#[cfg(test)]
mod installation_tests {
    use super::installation_type;

    #[test]
    fn docker_is_explicit_deployment_metadata() {
        assert_eq!(
            installation_type(false, false, Some("docker")),
            Some("container")
        );
        assert_eq!(
            installation_type(false, false, Some(" Docker ")),
            Some("container")
        );
        for value in [
            None,
            Some(""),
            Some("  "),
            Some("web-server"),
            Some("unknown"),
        ] {
            assert_eq!(installation_type(false, false, value), None);
        }
    }

    #[test]
    fn packaging_features_take_precedence() {
        assert_eq!(
            installation_type(true, true, Some("docker")),
            Some("flatpak")
        );
        assert_eq!(
            installation_type(false, true, Some("docker")),
            Some("portable")
        );
        assert_eq!(installation_type(true, false, None), Some("flatpak"));
        assert_eq!(installation_type(false, true, None), Some("portable"));
    }
}

#[cfg(test)]
mod exit_tests {
    use super::*;
    use crate::context::{AppHandle, ExitDecision, Host};
    use crate::rclone::backend::BackendManager;
    use crate::utils::types::jobs::{JobInfo, JobStatus, JobType};
    use futures::FutureExt;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct ConfirmingHost(AtomicBool);
    #[async_trait::async_trait]
    impl Host for ConfirmingHost {
        fn resolve_paths(
            &self,
            _app: &AppHandle,
        ) -> Result<crate::services::paths::AppPaths, String> {
            Err("Paths are not needed for deferred exit".into())
        }
        fn restart(&self, _app: &AppHandle) -> Result<(), String> {
            Err("Restart is not needed for deferred exit".into())
        }
        fn confirm_exit(&self, summary: ActiveOperationsSummary) -> ExitDecision {
            assert!(summary.has_active_operations);
            assert_eq!(summary.active_jobs_count, 1);
            self.0.store(true, Ordering::SeqCst);
            ExitDecision::Deferred
        }
    }

    #[tokio::test]
    async fn deferred_confirmation_keeps_application_and_jobs_running() {
        let host = Arc::new(ConfirmingHost(AtomicBool::new(false)));
        let app = AppHandle::new(host.clone(), Default::default());
        let manager = BackendManager::new();
        manager
            .job_cache()
            .await
            .add_job(JobInfo {
                jobid: 1,
                job_type: JobType::Copy,
                remote_name: "remote".into(),
                source: vec!["remote:file".into()],
                destination: "/destination".into(),
                start_time: chrono::Utc::now(),
                end_time: None,
                status: JobStatus::Running,
                error: None,
                stats: None,
                group: "job/1".into(),
                profile: None,
                execute_id: None,
                quick_run_id: None,
                origin: None,
                backend_name: crate::rclone::backend::types::default_backend_name(),
                dry_run: false,
                parent_job_id: None,
                workflow_id: None,
                node_id: None,
            })
            .await;
        app.manage(manager);
        request_app_exit(app.clone()).await.unwrap();
        assert!(host.0.load(Ordering::SeqCst));
        assert!(app.wait_for_exit().now_or_never().is_none());
        assert_eq!(
            app.state::<BackendManager>()
                .job_cache()
                .await
                .get_active_jobs()
                .await
                .len(),
            1
        );
    }
}
