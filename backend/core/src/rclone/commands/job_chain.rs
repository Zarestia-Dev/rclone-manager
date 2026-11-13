//! Jobs of one request that must run one after another (archive, cryptcheck).
//!
//! rclone runs each of them as its own job, so a request with several sources is a chain:
//! the next job starts when the previous one has finished.

use std::time::Duration;

use serde_json::Value;

use super::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};
use super::job_parser::JobOutcome;
use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, types::Backend};
use crate::rclone::state::job::JobPoll;

/// The longest a running link of the chain goes unchecked. A link is normally noticed the
/// moment it finishes (the cache wakes the chain); this only covers a wake-up that was missed.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

pub(crate) struct ChainJob {
    pub endpoint: &'static str,
    pub payload: Value,
    pub metadata: JobMetadata,
}

/// Who waits for the chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainMode {
    /// The caller gets the id of the last job once every earlier job has finished. A workflow
    /// node needs this: it follows that one job to know when the whole request is done.
    Foreground,
    /// The caller gets the id of the first job at once and the rest follows in the background.
    /// A request from the UI or an automation must not be held open for hours: a closed
    /// connection would end a foreground chain halfway.
    Background,
}

/// Runs the jobs one after another and returns the job id the caller should follow.
///
/// Only the last job carries the request's execution identity, so an automation completes
/// when the chain does. A chain that ends early completes it with the reason.
pub(crate) async fn run_chain(
    app: AppHandle,
    backend: Backend,
    jobs: Vec<ChainJob>,
    mode: ChainMode,
) -> Result<u64, String> {
    // Jobs that are not cached cannot be followed, so they are never chained in the background.
    let background = mode == ChainMode::Background
        && jobs.len() > 1
        && jobs.iter().all(|job| !job.metadata.no_cache);
    if background {
        run_in_background(app, backend, jobs).await
    } else {
        run_in_foreground(app, backend, jobs).await
    }
}

async fn submit(
    app: &AppHandle,
    backend: &Backend,
    job: ChainJob,
    wait: bool,
) -> Result<u64, String> {
    submit_job_with_options(
        app.clone(),
        job.endpoint,
        job.payload,
        job.metadata,
        SubmitJobOptions {
            backend: Some(backend.clone()),
            wait_for_completion: wait,
        },
    )
    .await
    .map(|submission| submission.job_id)
}

async fn run_in_foreground(
    app: AppHandle,
    backend: Backend,
    jobs: Vec<ChainJob>,
) -> Result<u64, String> {
    let last = jobs.len().saturating_sub(1);
    let mut job_id = 0;
    for (index, mut job) in jobs.into_iter().enumerate() {
        let wait = index < last;
        if wait {
            job.metadata.execute_id = None;
        }
        job_id = submit(&app, &backend, job, wait).await?;
    }
    Ok(job_id)
}

async fn run_in_background(
    app: AppHandle,
    backend: Backend,
    jobs: Vec<ChainJob>,
) -> Result<u64, String> {
    let execute_id = jobs.last().and_then(|job| job.metadata.execute_id.clone());
    let mut jobs = jobs.into_iter();
    let Some(mut first) = jobs.next() else {
        return Ok(0);
    };
    first.metadata.execute_id = None;
    let first_id = submit(&app, &backend, first, false).await?;

    let rest: Vec<ChainJob> = jobs.collect();
    crate::utils::spawn(async move {
        if let Err(outcome) = follow(&app, &backend, first_id, rest).await
            && let Some(execute_id) = execute_id
        {
            crate::services::automation::engine::finish_job_execution(
                &app,
                &backend.name,
                Some(&execute_id),
                &outcome,
            )
            .await;
        }
    });
    Ok(first_id)
}

/// Starts each remaining job when the one before it has completed. The error is the outcome
/// of the chain when it ends early.
async fn follow(
    app: &AppHandle,
    backend: &Backend,
    mut previous: u64,
    rest: Vec<ChainJob>,
) -> Result<(), JobOutcome> {
    let cache = app.state::<BackendManager>().job_cache_for(&backend.name);
    let last = rest.len().saturating_sub(1);
    for (index, mut job) in rest.into_iter().enumerate() {
        wait_for_job(&cache, previous).await?;
        if index < last {
            job.metadata.execute_id = None;
        }
        previous = submit(app, backend, job, false)
            .await
            .map_err(|error| failure(Some(error)))?;
    }
    Ok(())
}

/// Waits until the job has completed; a job that did not complete ends the chain.
async fn wait_for_job(
    cache: &crate::utils::types::jobs::JobCache,
    id: u64,
) -> Result<(), JobOutcome> {
    loop {
        // Registered before the look, so a job that finishes in between wakes the wait.
        let changed = cache.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        match cache.poll_job(id).await {
            JobPoll::Running => {
                let _ = tokio::time::timeout(POLL_INTERVAL, changed).await;
            }
            JobPoll::Completed(_) => return Ok(()),
            JobPoll::Failed(job) => return Err(failure(job.error)),
            JobPoll::Stopped => {
                return Err(JobOutcome {
                    success: false,
                    stopped: true,
                    error_msg: None,
                    cryptcheck_output: None,
                });
            }
            JobPoll::Missing => {
                return Err(failure(Some(crate::localized_error!(
                    "backendErrors.job.lost"
                ))));
            }
        }
    }
}

fn failure(error: Option<String>) -> JobOutcome {
    JobOutcome {
        success: false,
        stopped: false,
        error_msg: error,
        cryptcheck_output: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::jobs::{JobCache, JobInfo, JobStatus, JobType};
    use serde_json::json;

    async fn cache_with(status: JobStatus, error: Option<&str>) -> JobCache {
        let cache = JobCache::new();
        let job = JobInfo {
            job_type: JobType::ArchiveCreate,
            source: vec!["drive:a".into()],
            destination: "/out".into(),
            ..JobInfo::for_test()
        };
        cache.add_job(job).await;
        match status {
            JobStatus::Completed => cache.complete_job(1, true, None).await.map(|_| ()),
            JobStatus::Failed => cache
                .complete_job(1, false, error.map(str::to_string))
                .await
                .map(|_| ()),
            JobStatus::Stopped => cache.stop_job(1).await,
            JobStatus::Running => Ok(()),
        }
        .unwrap();
        cache
    }

    #[tokio::test]
    async fn the_chain_notices_a_finished_job_without_waiting_out_the_poll_interval() {
        let cache = std::sync::Arc::new(cache_with(JobStatus::Running, None).await);
        let finisher = cache.clone();
        let started = std::time::Instant::now();
        crate::utils::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            finisher.complete_job(1, true, None).await.unwrap();
        });

        assert!(wait_for_job(&cache, 1).await.is_ok());
        assert!(
            started.elapsed() < POLL_INTERVAL,
            "took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn the_chain_goes_on_only_after_a_completed_job() {
        let cache = cache_with(JobStatus::Completed, None).await;
        assert!(wait_for_job(&cache, 1).await.is_ok());
    }

    #[tokio::test]
    async fn a_failed_stopped_or_vanished_job_ends_the_chain_with_its_reason() {
        let failed = cache_with(JobStatus::Failed, Some("disk full")).await;
        let outcome = wait_for_job(&failed, 1).await.unwrap_err();
        assert!(!outcome.success && !outcome.stopped);
        assert_eq!(outcome.error_msg.as_deref(), Some("disk full"));

        let stopped = cache_with(JobStatus::Stopped, None).await;
        let outcome = wait_for_job(&stopped, 1).await.unwrap_err();
        assert!(outcome.stopped && !outcome.success);

        let outcome = wait_for_job(&JobCache::new(), 1).await.unwrap_err();
        assert!(
            outcome
                .error_msg
                .unwrap()
                .contains("backendErrors.job.lost")
        );
    }

    #[tokio::test]
    async fn a_running_job_is_waited_for_until_it_finishes() {
        let cache = std::sync::Arc::new(cache_with(JobStatus::Running, None).await);
        let waiter = {
            let cache = cache.clone();
            tokio::spawn(async move { wait_for_job(&cache, 1).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished());
        cache.complete_job(1, true, None).await.unwrap();
        assert!(waiter.await.unwrap().is_ok());
    }

    /// A daemon that numbers the jobs it is given from 11 and finishes them at the first poll,
    /// the one in `failing` unsuccessfully. It records every request path.
    struct Daemon {
        app: AppHandle,
        backend: Backend,
        requests: std::sync::Arc<parking_lot::Mutex<Vec<String>>>,
    }

    async fn daemon(failing: Option<u64>) -> Daemon {
        use crate::rclone::backend::routing_transport::RoutingTransport;
        use crate::rclone::state::automations::AutomationsCache;
        use crate::utils::types::state::RcloneState;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::new_remote(
            "Chain NAS",
            "127.0.0.1",
            listener.local_addr().unwrap().port(),
        );
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        app.manage(AutomationsCache::new());
        app.manage(RcloneState::new(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            std::sync::Arc::new(RoutingTransport::new(app.clone())),
        ));
        let requests = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let seen = requests.clone();
        crate::utils::spawn(async move {
            let mut next_job = 11u64;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (header_end, length, path) = loop {
                    if stream.read_buf(&mut request).await.unwrap() == 0 {
                        break (0, 0, String::new());
                    }
                    if let Some(index) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..index]).to_string();
                        let path = headers.split_whitespace().nth(1).unwrap().to_string();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (index + 4, length, path);
                    }
                };
                while request.len() < header_end + length {
                    if stream.read_buf(&mut request).await.unwrap() == 0 {
                        break;
                    }
                }
                let body: Value =
                    serde_json::from_slice(&request[header_end..]).unwrap_or(Value::Null);
                seen.lock().push(path.clone());
                let response = if path == "/job/batch" {
                    let id = body["inputs"][0]["jobid"].as_u64().unwrap_or(0);
                    let failed = failing == Some(id);
                    json!({"results": [
                        {"finished": true, "success": !failed, "executeId": "run",
                         "error": if failed { "boom" } else { "" }, "output": {}},
                        {"bytes": 1}, {"transferred": []}
                    ]})
                } else if path.starts_with("/operations/") {
                    next_job += 1;
                    json!({"jobid": next_job - 1})
                } else {
                    json!({})
                };
                let response = response.to_string();
                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                            response.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            }
        });
        Daemon {
            app,
            backend,
            requests,
        }
    }

    fn archive_jobs(count: usize, execute_id: &str) -> Vec<ChainJob> {
        (0..count)
            .map(|n| ChainJob {
                endpoint: "operations/archive",
                payload: json!({"src": format!("drive:{n}"), "dst": "/out"}),
                metadata: JobMetadata::new(
                    "drive:",
                    JobType::ArchiveCreate,
                    vec![format!("drive:{n}")],
                    "/out",
                )
                .with_execute_id(Some(execute_id.to_string())),
            })
            .collect()
    }

    async fn started_automation(daemon: &Daemon) -> String {
        use crate::rclone::state::automations::AutomationsCache;
        let cache = daemon.app.state::<AutomationsCache>();
        let args = crate::utils::types::automation::AutomationArgs {
            source: crate::utils::types::origin::Origin::Automation,
            src_paths: vec!["drive:".into()],
            dst_paths: vec!["/out".into()],
        };
        let automation = crate::utils::types::automation::Automation::new(
            "chain".into(),
            Some(crate::utils::types::remotes::OperationType::Archivecreate),
            "drive:".into(),
            "archive".into(),
            args,
            &daemon.backend.name,
        );
        cache.add_automation(automation).await.unwrap();
        cache
            .try_start_automation("chain", &daemon.backend.name, None)
            .await
            .unwrap()
            .unwrap()
            .execution_id
            .unwrap()
    }

    async fn until<F: std::future::Future<Output = bool>>(mut check: impl FnMut() -> F) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while !check().await {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("condition was not reached in time");
    }

    #[tokio::test]
    async fn a_background_chain_returns_the_first_job_and_submits_the_rest_when_it_completes() {
        use crate::rclone::state::automations::AutomationsCache;
        let daemon = daemon(None).await;
        let execution = started_automation(&daemon).await;
        let first = run_chain(
            daemon.app.clone(),
            daemon.backend.clone(),
            archive_jobs(2, &execution),
            ChainMode::Background,
        )
        .await
        .unwrap();
        assert_eq!(first, 11);
        let submitted = || {
            daemon
                .requests
                .lock()
                .iter()
                .filter(|p| *p == "/operations/archive")
                .count()
        };
        // The second job follows the first without anyone waiting for it.
        until(|| async { submitted() == 2 }).await;
        // The automation completes with the last job, not with the first.
        let cache = daemon.app.state::<AutomationsCache>();
        until(|| async { cache.get_automation("chain").await.unwrap().success_count == 1 }).await;
    }

    #[tokio::test]
    async fn a_failing_link_ends_the_chain_and_completes_the_automation_with_its_error() {
        use crate::rclone::state::automations::AutomationsCache;
        let daemon = daemon(Some(11)).await;
        let execution = started_automation(&daemon).await;
        let first = run_chain(
            daemon.app.clone(),
            daemon.backend.clone(),
            archive_jobs(3, &execution),
            ChainMode::Background,
        )
        .await
        .unwrap();
        assert_eq!(first, 11);
        let cache = daemon.app.state::<AutomationsCache>();
        until(|| async { cache.get_automation("chain").await.unwrap().failure_count == 1 }).await;
        let automation = cache.get_automation("chain").await.unwrap();
        assert_eq!(automation.last_error.as_deref(), Some("boom"));
        assert!(automation.execution_id.is_none());
        let submitted = daemon
            .requests
            .lock()
            .iter()
            .filter(|p| *p == "/operations/archive")
            .count();
        assert_eq!(submitted, 1, "later jobs must not start after a failure");
    }

    #[tokio::test]
    async fn a_foreground_chain_returns_the_last_job_after_the_earlier_ones_finished() {
        let daemon = daemon(None).await;
        let execution = started_automation(&daemon).await;
        let last = run_chain(
            daemon.app.clone(),
            daemon.backend.clone(),
            archive_jobs(2, &execution),
            ChainMode::Foreground,
        )
        .await
        .unwrap();
        assert_eq!(last, 12);
    }
}
