//! Application exit confirmation and restart orchestration, shared by hosts.
use crate::context::AppHandle;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActiveOperationsSummary {
    pub has_active_operations: bool,
    pub active_jobs_count: usize,
    pub active_mounts_count: usize,
    pub active_serves_count: usize,
}

#[derive(Default)]
struct PendingExit(parking_lot::Mutex<Option<ActiveOperationsSummary>>);

pub fn set_pending_app_exit_summary(app: &AppHandle, summary: ActiveOperationsSummary) {
    app.manage(PendingExit::default());
    *app.state::<PendingExit>().0.lock() = Some(summary);
}

#[must_use]
pub fn check_pending_app_exit(app: AppHandle) -> Option<ActiveOperationsSummary> {
    app.try_state::<PendingExit>()
        .and_then(|state| state.0.lock().take())
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

    #[test]
    fn pending_confirmation_belongs_to_one_application_and_is_consumed_once() {
        let app = AppHandle::default();
        let other = AppHandle::default();
        assert!(check_pending_app_exit(app.clone()).is_none());
        set_pending_app_exit_summary(
            &app,
            ActiveOperationsSummary {
                has_active_operations: true,
                active_jobs_count: 2,
                active_mounts_count: 0,
                active_serves_count: 1,
            },
        );
        assert!(check_pending_app_exit(other).is_none());
        let summary = check_pending_app_exit(app.clone()).unwrap();
        assert_eq!(summary.active_jobs_count, 2);
        assert_eq!(summary.active_serves_count, 1);
        assert!(check_pending_app_exit(app).is_none());
    }

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
                stats_revision: 0,
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
