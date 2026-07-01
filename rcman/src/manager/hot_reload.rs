use crate::config::{HotReloadBackend, HotReloadConfig, SettingsSchema};
use crate::error::Result;
use crate::manager::SettingsManager;
use crate::storage::StorageBackend;

use notify::{Config, Event, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

/// Event emitted by the hot-reload runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HotReloadEvent {
    /// Reload completed and cache has been refreshed.
    Reloaded { path: PathBuf },
    /// Reload attempt failed.
    ReloadFailed { path: PathBuf, reason: String },
    /// Watcher setup/runtime error.
    WatchError { reason: String },
}

enum WatcherKind {
    Recommended(RecommendedWatcher),
    Poll(PollWatcher),
}

impl WatcherKind {
    fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()> {
        match self {
            Self::Recommended(watcher) => watcher.watch(path, recursive_mode),
            Self::Poll(watcher) => watcher.watch(path, recursive_mode),
        }
    }
}

/// Running hot-reload worker handle.
pub struct HotReloadRuntime {
    stop_tx: Sender<()>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl HotReloadRuntime {
    /// Start hot-reload watching for the manager's active settings file.
    ///
    /// # Errors
    ///
    /// Returns an error if the manager cannot resolve the active settings path.
    pub fn start<S, Schema, F>(
        manager: Arc<SettingsManager<S, Schema>>,
        config: HotReloadConfig,
        on_event: F,
    ) -> Result<Self>
    where
        S: StorageBackend + 'static,
        Schema: SettingsSchema + Send + Sync + 'static,
        F: Fn(HotReloadEvent) + Send + Sync + 'static,
    {
        let watched_file = manager.settings_path()?;
        let watch_target = watched_file
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();

        let callback: Arc<dyn Fn(HotReloadEvent) + Send + Sync> = Arc::new(on_event);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let join_handle = thread::spawn(move || {
            let (fs_tx, fs_rx) = mpsc::channel::<notify::Result<Event>>();

            let mut watcher = match create_watcher(&config, fs_tx) {
                Ok(watcher) => watcher,
                Err(err) => {
                    callback(HotReloadEvent::WatchError {
                        reason: err.to_string(),
                    });
                    return;
                }
            };

            if let Err(err) = watcher.watch(&watch_target, RecursiveMode::NonRecursive) {
                callback(HotReloadEvent::WatchError {
                    reason: err.to_string(),
                });
                return;
            }

            run_reload_loop(
                &manager,
                &watched_file,
                &config,
                &callback,
                &fs_rx,
                &stop_rx,
            );
        });

        Ok(Self {
            stop_tx,
            join_handle: Some(join_handle),
        })
    }

    /// Stop hot-reload worker and join thread.
    pub fn stop(&mut self) {
        if self.stop_tx.send(()).is_err() {
            // Worker already stopped.
        }

        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for HotReloadRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn create_watcher(
    config: &HotReloadConfig,
    fs_tx: Sender<notify::Result<Event>>,
) -> notify::Result<WatcherKind> {
    let watcher_config =
        Config::default().with_poll_interval(Duration::from_millis(config.poll_interval_ms));

    match config.backend {
        HotReloadBackend::Auto => {
            RecommendedWatcher::new(fs_tx, watcher_config).map(WatcherKind::Recommended)
        }
        HotReloadBackend::Poll => PollWatcher::new(fs_tx, watcher_config).map(WatcherKind::Poll),
    }
}

fn run_reload_loop<S, Schema>(
    manager: &Arc<SettingsManager<S, Schema>>,
    watched_file: &Path,
    config: &HotReloadConfig,
    callback: &Arc<dyn Fn(HotReloadEvent) + Send + Sync>,
    fs_rx: &Receiver<notify::Result<Event>>,
    stop_rx: &Receiver<()>,
) where
    S: StorageBackend + 'static,
    Schema: SettingsSchema + Send + Sync + 'static,
{
    let debounce_window = Duration::from_millis(config.debounce_ms);
    let self_write_suppression = Duration::from_millis(150);

    let mut pending_reload = false;
    let mut last_change = Instant::now();
    let mut suppress_until = Instant::now();

    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => {}
        }

        match fs_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(event)) => {
                if event_touches_file(&event, watched_file) {
                    pending_reload = true;
                    last_change = Instant::now();
                }
            }
            Ok(Err(err)) => {
                callback(HotReloadEvent::WatchError {
                    reason: err.to_string(),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if pending_reload
            && Instant::now() >= suppress_until
            && Instant::now().duration_since(last_change) >= debounce_window
        {
            manager.invalidate_cache();

            match manager.ensure_cache_populated() {
                Ok(()) => {
                    callback(HotReloadEvent::Reloaded {
                        path: watched_file.to_path_buf(),
                    });
                }
                Err(err) => {
                    callback(HotReloadEvent::ReloadFailed {
                        path: watched_file.to_path_buf(),
                        reason: err.to_string(),
                    });
                }
            }

            pending_reload = false;
            suppress_until = Instant::now() + self_write_suppression;
        }
    }
}

fn event_touches_file(event: &Event, watched_file: &Path) -> bool {
    let watched_name = watched_file.file_name();

    event.paths.iter().any(|path| {
        if path == watched_file {
            return true;
        }

        match (path.file_name(), watched_name) {
            (Some(path_name), Some(expected_name)) => path_name == expected_name,
            _ => false,
        }
    })
}
