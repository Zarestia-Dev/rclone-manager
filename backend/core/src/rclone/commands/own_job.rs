//! Jobs this process carries out itself instead of rclone: an upload streamed to an rclone on
//! another computer, a file downloaded or opened onto this device. They are listed, followed and
//! stopped like rclone's jobs, under ids of their own, with stats in rclone's `core/stats` shape.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::rclone::commands::job::JobMetadata;
use crate::utils::app::notification::notify;
use crate::utils::io::staged_file::{CopyError, copy_in_chunks};
use crate::utils::types::jobs::{JobCache, JobStatus, OwnJobCancellation};

/// How often a running job reports its progress.
const REPORT_INTERVAL: Duration = Duration::from_millis(500);
/// The finished files a report lists while the job runs; the last report lists them all.
const RUNNING_HISTORY: usize = 100;

/// A file a job moves, as its transfer lists show it.
pub struct FileCopy {
    pub name: String,
    /// The folder it comes from (`drive:docs`) and the one it goes to.
    pub src_fs: String,
    pub dst_fs: String,
    pub size: u64,
}

/// A file being moved: the reports read how far it is.
pub struct Transfer {
    file: FileCopy,
    started: Instant,
    started_at: DateTime<Utc>,
    bytes: AtomicU64,
}

impl Transfer {
    /// Counts `bytes` more of the file as moved.
    pub fn add_bytes(&self, bytes: u64) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn row(&self, group: &str) -> Value {
        let bytes = self.bytes.load(Ordering::Relaxed);
        let size = self.file.size;
        let speed = per_second(bytes, self.started.elapsed());
        json!({
            "name": &self.file.name,
            "size": size,
            "bytes": bytes,
            "percentage": (bytes.min(size) * 100).checked_div(size).unwrap_or(0),
            "speed": speed,
            "speedAvg": speed,
            "eta": seconds_left(size, bytes, speed),
            "srcFs": &self.file.src_fs,
            "dstFs": &self.file.dst_fs,
            "group": group,
        })
    }
}

/// What a job has moved so far.
struct Progress {
    started: Instant,
    total_bytes: u64,
    total_files: usize,
    /// The bytes of the files that arrived.
    done_bytes: u64,
    transferring: Vec<Arc<Transfer>>,
    completed: Vec<Value>,
    errors: Vec<String>,
}

fn per_second(bytes: u64, elapsed: Duration) -> f64 {
    let seconds = elapsed.as_secs_f64();
    if seconds > 0.0 {
        bytes as f64 / seconds
    } else {
        0.0
    }
}

fn seconds_left(total: u64, done: u64, speed: f64) -> Option<u64> {
    (speed > 0.0 && total > done).then(|| ((total - done) as f64 / speed) as u64)
}

/// An id no other job of this process has, kept within what a JavaScript number holds: the
/// current time in milliseconds, or one more than the last id when two start in the same one.
pub(crate) fn next_jobid() -> u64 {
    static LAST_ID: AtomicU64 = AtomicU64::new(0);
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let previous = LAST_ID
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |last| {
            Some(now.max(last + 1))
        })
        .expect("job ID update cannot fail");
    now.max(previous + 1)
}

/// A running job of this process. Dropping it without [`OwnJob::finish`] (a panicking task)
/// still ends it: it is marked stopped and taken off the jobs that can be stopped.
pub struct OwnJob {
    app: AppHandle,
    cache: Arc<JobCache>,
    backend_name: String,
    metadata: JobMetadata,
    id: u64,
    token: CancellationToken,
    stopped: watch::Sender<Option<Result<(), String>>>,
    transient: bool,
    progress: parking_lot::Mutex<Progress>,
}

impl OwnJob {
    /// Lists a running job that moves `total_files` files of `total_bytes` among
    /// `backend_name`'s jobs. A `transient` job, a file opened in another app, is announced and
    /// kept in the history only when it fails.
    pub async fn start(
        app: &AppHandle,
        backend_name: &str,
        mut metadata: JobMetadata,
        transient: bool,
        total_bytes: u64,
        total_files: usize,
    ) -> Self {
        let cache = app.state::<BackendManager>().job_cache_for(backend_name);
        let id = next_jobid();
        metadata.prepare_execution();
        let token = CancellationToken::new();
        let (stopped, result) = watch::channel(None);
        cache.own_jobs.lock().insert(
            id,
            OwnJobCancellation {
                token: token.clone(),
                result,
            },
        );
        cache
            .create_job(id, metadata.clone(), backend_name.to_string(), None)
            .await;
        cache.prune_finished(Some(app)).await;
        if !transient {
            notify(app, metadata.started_event(backend_name.to_string()));
        }
        Self {
            app: app.clone(),
            cache,
            backend_name: backend_name.to_string(),
            metadata,
            id,
            token,
            stopped,
            transient,
            progress: parking_lot::Mutex::new(Progress {
                started: Instant::now(),
                total_bytes,
                total_files,
                done_bytes: 0,
                transferring: Vec::new(),
                completed: Vec::new(),
                errors: Vec::new(),
            }),
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    /// The rclone stats group the job's transfer lists name.
    pub fn group(&self) -> String {
        self.metadata.group_name()
    }

    /// Cancelled when the user stops the job.
    pub fn cancellation(&self) -> &CancellationToken {
        &self.token
    }

    /// How many files failed so far.
    pub fn failed_files(&self) -> usize {
        self.progress.lock().errors.len()
    }

    /// Lists `file` among the files being moved; [`OwnJob::end`] lists it as done.
    pub fn begin(&self, file: FileCopy) -> Arc<Transfer> {
        let transfer = Arc::new(Transfer {
            file,
            started: Instant::now(),
            started_at: Utc::now(),
            bytes: AtomicU64::new(0),
        });
        self.progress.lock().transferring.push(transfer.clone());
        transfer
    }

    /// Lists a file [`OwnJob::begin`] listed as done, or as failed with its error.
    pub fn end(&self, transfer: &Arc<Transfer>, result: Result<(), String>) {
        let bytes = transfer.bytes.load(Ordering::Relaxed);
        let file = &transfer.file;
        let row = json!({
            "name": &file.name,
            "size": file.size,
            "bytes": bytes,
            "error": result.as_ref().err().map_or("", String::as_str),
            "started_at": transfer.started_at,
            "completed_at": Utc::now(),
            "srcFs": &file.src_fs,
            "dstFs": &file.dst_fs,
            "group": self.group(),
        });
        let mut progress = self.progress.lock();
        progress
            .transferring
            .retain(|other| !Arc::ptr_eq(other, transfer));
        progress.completed.push(row);
        match result {
            Ok(()) => progress.done_bytes += bytes,
            Err(error) => progress.errors.push(error),
        }
    }

    /// Runs `work`, reporting the job's progress every half second until it is done.
    pub async fn run<T>(&self, work: impl Future<Output = T>) -> T {
        let reports = async {
            loop {
                tokio::time::sleep(REPORT_INTERVAL).await;
                self.report(Some(RUNNING_HISTORY)).await;
            }
        };
        tokio::select! {
            output = work => output,
            () = reports => unreachable!("reports never end"),
        }
    }

    /// Copies one file from `reader` into `writer` until it is done, fails, or the user stops
    /// the job (a stalled read included). `check` runs before each chunk is written and can
    /// refuse to go on.
    pub async fn copy_file(
        &self,
        file: FileCopy,
        reader: &mut (impl AsyncRead + Unpin),
        writer: &mut (impl AsyncWrite + Unpin),
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<u64, CopyError> {
        let transfer = self.begin(file);
        let copy = copy_in_chunks(reader, writer, |bytes| {
            transfer.bytes.store(bytes, Ordering::Relaxed);
            check()
        });
        let result = self
            .run(async {
                tokio::select! {
                    result = copy => result,
                    () = self.token.cancelled() => Err(CopyError::Aborted(
                        crate::localized_error!("backendErrors.job.stopped"),
                    )),
                }
            })
            .await;
        self.end(
            &transfer,
            result.as_ref().map(|_| ()).map_err(|error| match error {
                CopyError::Io(error) => error.to_string(),
                CopyError::Aborted(message) => message.clone(),
            }),
        );
        result
    }

    /// Stores the job's stats, listing the last `history` finished files, or all of them.
    async fn report(&self, history: Option<usize>) {
        let stats = self.stats(history);
        let _ = self.cache.update_job_stats(self.id, stats).await;
    }

    fn stats(&self, history: Option<usize>) -> Value {
        let group = self.group();
        let progress = self.progress.lock();
        let elapsed = progress.started.elapsed();
        let moving = progress
            .transferring
            .iter()
            .map(|transfer| (transfer.bytes.load(Ordering::Relaxed), transfer.row(&group)));
        let (moving_bytes, transferring): (Vec<u64>, Vec<Value>) = moving.unzip();
        let bytes = progress.done_bytes + moving_bytes.iter().sum::<u64>();
        let speed = per_second(bytes, elapsed);
        let shown = history.map_or(0, |count| progress.completed.len().saturating_sub(count));
        json!({
            "bytes": bytes,
            "totalBytes": progress.total_bytes,
            "speed": speed,
            "eta": seconds_left(progress.total_bytes, bytes, speed),
            "elapsedTime": elapsed.as_secs_f64(),
            "transferTime": elapsed.as_secs_f64(),
            "transfers": progress.completed.len() - progress.errors.len(),
            "totalTransfers": progress.total_files,
            "errors": progress.errors.len(),
            "lastError": progress.errors.last().cloned().unwrap_or_default(),
            "checks": 0,
            "totalChecks": 0,
            "transferring": transferring,
            "completed": &progress.completed[shown..],
        })
    }

    /// Ends the job: stopped when the user stopped it, else completed, or failed with `error`.
    /// Returns what the caller reports: the error of a failure, or that the job was stopped.
    pub async fn finish(self, error: Option<String>) -> Result<(), String> {
        self.report(None).await;
        let result = self.settle(error).await;
        // A stop request waiting for this job learns that it is over, however it ended.
        self.stopped.send_replace(Some(Ok(())));
        result
    }

    async fn settle(&self, error: Option<String>) -> Result<(), String> {
        let stopped = crate::localized_error!("backendErrors.job.stopped");
        let backend = || self.backend_name.clone();
        if self.token.is_cancelled() {
            self.cache.stop_job(self.id).await?;
            notify(&self.app, self.metadata.stopped_event(backend()));
            return Err(stopped);
        }
        let status = self
            .cache
            .complete_job(self.id, error.is_none(), error.clone())
            .await?;
        if status == JobStatus::Stopped {
            notify(&self.app, self.metadata.stopped_event(backend()));
            return Err(stopped);
        }
        match &error {
            Some(message) => notify(&self.app, self.metadata.failed_event(backend(), message)),
            None if self.transient => self.cache.delete_job(self.id, Some(&self.app)).await?,
            None => notify(&self.app, self.metadata.completed_event(backend())),
        }
        error.map_or(Ok(()), Err)
    }
}

impl Drop for OwnJob {
    fn drop(&mut self) {
        self.token.cancel();
        self.cache.own_jobs.lock().remove(&self.id);
        let unfinished = self.stopped.send_if_modified(|result| {
            let unfinished = result.is_none();
            if unfinished {
                *result = Some(Err(crate::localized_error!("backendErrors.job.failed")));
            }
            unfinished
        });
        if unfinished {
            // A job that never finished must not stay running in the list.
            let (cache, id) = (self.cache.clone(), self.id);
            crate::utils::spawn(async move {
                let _ = cache.stop_job(id).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::jobs::JobType;

    fn app() -> AppHandle {
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        app
    }

    fn metadata() -> JobMetadata {
        JobMetadata::new(
            "drive:",
            JobType::Download,
            vec!["drive:a.bin".into()],
            "/tmp/a.bin",
        )
    }

    fn file(size: u64) -> FileCopy {
        FileCopy {
            name: "a.bin".into(),
            src_fs: "drive:".into(),
            dst_fs: "/tmp".into(),
            size,
        }
    }

    #[tokio::test]
    async fn a_copied_file_completes_the_job_and_lists_the_file() {
        let app = app();
        let job = OwnJob::start(&app, "Local", metadata(), false, 5, 1).await;
        let (id, cache) = (job.id(), job.cache.clone());
        assert!(cache.own_jobs.lock().contains_key(&id));
        let mut written = Vec::new();
        let copied = job
            .copy_file(file(5), &mut &b"12345"[..], &mut written, || Ok(()))
            .await
            .unwrap();
        assert_eq!((copied, written.as_slice()), (5, &b"12345"[..]));
        job.finish(None).await.unwrap();

        let done = cache.get_job(id).await.unwrap();
        assert_eq!(done.status, JobStatus::Completed);
        let stats = done.stats.unwrap();
        assert_eq!(stats["bytes"], 5);
        assert_eq!(stats["transfers"], 1);
        assert_eq!(stats["completed"][0]["name"], "a.bin");
        assert!(stats["transferring"].as_array().unwrap().is_empty());
        assert!(!cache.own_jobs.lock().contains_key(&id));
    }

    #[tokio::test]
    async fn an_opened_file_leaves_no_job_unless_it_fails() {
        let app = app();
        let job = OwnJob::start(&app, "Local", metadata(), true, 5, 1).await;
        let (id, cache) = (job.id(), job.cache.clone());
        job.finish(None).await.unwrap();
        assert!(cache.get_job(id).await.is_none());

        let job = OwnJob::start(&app, "Local", metadata(), true, 5, 1).await;
        let (id, cache) = (job.id(), job.cache.clone());
        let refused = job
            .copy_file(file(5), &mut &b"12345"[..], &mut Vec::new(), || {
                Err("vault locked".into())
            })
            .await;
        assert!(refused.is_err());
        assert_eq!(
            job.finish(Some("vault locked".into())).await.unwrap_err(),
            "vault locked"
        );
        let failed = cache.get_job(id).await.unwrap();
        assert_eq!(failed.status, JobStatus::Failed);
        assert_eq!(
            failed.stats.unwrap()["completed"][0]["error"],
            "vault locked"
        );
    }

    #[tokio::test]
    async fn stopping_ends_even_a_stalled_copy() {
        let app = app();
        let job = OwnJob::start(&app, "Local", metadata(), false, 5, 1).await;
        let (id, cache) = (job.id(), job.cache.clone());
        // A reader that never delivers anything.
        let (_writer, mut stalled) = tokio::io::duplex(8);
        let run = async {
            let copied = job
                .copy_file(file(100), &mut stalled, &mut Vec::new(), || Ok(()))
                .await;
            assert!(copied.is_err());
            job.finish(Some("stopped".into())).await
        };
        let (finished, stopped) = tokio::join!(run, cache.cancel_own_job(id));
        assert!(finished.unwrap_err().contains("backendErrors.job.stopped"));
        assert!(stopped.unwrap());
        assert_eq!(cache.get_job(id).await.unwrap().status, JobStatus::Stopped);
        assert!(!cache.own_jobs.lock().contains_key(&id));
    }

    #[tokio::test]
    async fn files_moved_side_by_side_add_up_while_they_move_and_once_done() {
        let app = app();
        let job = OwnJob::start(&app, "Local", metadata(), false, 30, 3).await;
        let (id, cache) = (job.id(), job.cache.clone());
        let a = job.begin(file(10));
        let b = job.begin(file(20));
        a.add_bytes(4);
        b.add_bytes(6);
        let stats = job.stats(Some(RUNNING_HISTORY));
        assert_eq!(stats["bytes"], 10);
        assert_eq!(stats["totalBytes"], 30);
        assert_eq!(stats["transferring"].as_array().unwrap().len(), 2);
        assert_eq!(stats["transferring"][0]["percentage"], 40);

        a.add_bytes(6);
        job.end(&a, Ok(()));
        // A failed file keeps the bytes it moved in its row, not in the job's total.
        job.end(&b, Err("quota".into()));
        let stats = job.stats(None);
        assert_eq!(stats["bytes"], 10);
        assert_eq!(stats["transfers"], 1);
        assert_eq!(stats["totalTransfers"], 3);
        assert_eq!(stats["errors"], 1);
        assert_eq!(stats["lastError"], "quota");
        assert_eq!(stats["completed"][1]["bytes"], 6);
        assert!(stats["transferring"].as_array().unwrap().is_empty());
        assert_eq!(job.failed_files(), 1);

        job.finish(Some("1 failed".into())).await.unwrap_err();
        let failed = cache.get_job(id).await.unwrap();
        assert_eq!(failed.status, JobStatus::Failed);
        assert_eq!(
            failed.stats.unwrap()["completed"].as_array().unwrap().len(),
            2
        );
    }

    #[tokio::test]
    async fn a_stop_waiting_for_a_job_that_completed_is_answered() {
        let app = app();
        let job = OwnJob::start(&app, "Local", metadata(), false, 5, 1).await;
        let (id, cache) = (job.id(), job.cache.clone());
        let mut result = cache.own_jobs.lock()[&id].result.clone();
        job.finish(None).await.unwrap();
        assert_eq!(*result.borrow_and_update(), Some(Ok(())));
        assert_eq!(
            cache.get_job(id).await.unwrap().status,
            JobStatus::Completed
        );
    }

    #[tokio::test]
    async fn a_job_dropped_unfinished_does_not_stay_running() {
        let app = app();
        let job = OwnJob::start(&app, "Local", metadata(), false, 5, 1).await;
        let (id, cache) = (job.id(), job.cache.clone());
        drop(job);
        assert!(!cache.own_jobs.lock().contains_key(&id));
        assert_eq!(
            cache.wait_until_finished(id).await.map(|job| job.status),
            Some(JobStatus::Stopped)
        );
    }

    #[test]
    fn concurrent_jobs_get_distinct_javascript_safe_ids() {
        let ids = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| (0..100).map(|_| next_jobid()).collect::<Vec<_>>()))
                .collect();
            handles
                .into_iter()
                .flat_map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        let unique = ids.iter().collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), ids.len());
        assert!(ids.iter().all(|id| *id <= (1u64 << 53)));
    }
}
