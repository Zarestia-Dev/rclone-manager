use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::rclone::state::automations::AutomationsCache;
use crate::rclone::state::cache::is_local_path;
use crate::services::automation::engine::{WatchTrigger, execute_automation};
use crate::services::settings::AppSettingsManager;
use crate::utils::json_helpers::build_full_path;
use crate::utils::types::automation::{Automation, AutomationArgs, AutomationStatus};
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::OperationType;
use chrono::{DateTime, Utc};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// How often a session with something to do looks at its state again.
const TICK: Duration = Duration::from_millis(500);
/// A watcher does not start an automation again this soon after its last run.
const COOLDOWN_SECS: i64 = 5;

/// Roots that do not exist yet. The session keeps retrying them.
type PendingRoots = Arc<parking_lot::Mutex<Vec<String>>>;

#[derive(Clone, PartialEq)]
struct WatchConfig {
    args: AutomationArgs,
    operation: OperationType,
    delay: u64,
    changed_only: bool,
    patterns: Vec<String>,
}

struct WatchSession {
    config: WatchConfig,
    task: tokio::task::JoinHandle<()>,
    pending_roots: PendingRoots,
}

impl Drop for WatchSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct WatcherManager {
    sessions: RwLock<HashMap<String, WatchSession>>,
}

impl WatcherManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub async fn sync_watchers(&self, app: AppHandle) -> Result<(), String> {
        let backend = app.state::<BackendManager>().get_active().await;
        let mut sessions = self.sessions.write().await;
        if !backend.is_local {
            sessions.clear();
            return Ok(());
        }
        let automations = app.state::<AutomationsCache>().get_all_automations().await;
        let active: HashSet<_> = automations
            .iter()
            .filter(|a| {
                a.belongs_to_backend(&backend.name)
                    && a.watch_enabled
                    && !matches!(
                        a.status,
                        AutomationStatus::Disabled | AutomationStatus::Stopping
                    )
            })
            .map(|a| a.id.clone())
            .collect();
        sessions.retain(|id, _| active.contains(id));
        let mut errors = Vec::new();
        for automation in automations.iter().filter(|a| active.contains(&a.id)) {
            let config = WatchConfig {
                args: automation.args.clone(),
                operation: automation.automation_type,
                delay: automation.watch_delay,
                changed_only: automation.watch_changed_only,
                patterns: workflow_patterns(&app, automation)?,
            };
            if sessions
                .get(&automation.id)
                .is_none_or(|session| session.config != config || session.task.is_finished())
            {
                // Drop the old loop before replacement, including its buffered events.
                sessions.remove(&automation.id);
                // Registering a recursive watch walks the whole tree; keep that off the runtime threads.
                let id = automation.id.clone();
                let (automation, app) = (automation.clone(), app.clone());
                let started = crate::utils::spawn_blocking(move || {
                    start_watch_session(&automation, config, app)
                })
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
                match started {
                    Ok(session) => {
                        sessions.insert(id, session);
                    }
                    Err(error) => errors.push(error),
                }
            }
            if let Some(session) = sessions.get(&automation.id) {
                let roots = session.pending_roots.lock();
                if !roots.is_empty() {
                    errors.push(crate::localized_error!(
                        "backendErrors.automation.watcherPending",
                        "paths" => roots.join(", ")
                    ));
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(
                crate::localized_error!("backendErrors.automation.executionFailed", "error" => errors.join("; ")),
            )
        }
    }

    pub async fn stop_all(&self) {
        self.sessions.write().await.clear();
    }
}

impl Default for WatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

/// The glob patterns a workflow trigger filters changed paths with.
fn workflow_patterns(app: &AppHandle, automation: &Automation) -> Result<Vec<String>, String> {
    if automation.args.params.source != Some(Origin::Flow) {
        return Ok(Vec::new());
    }
    let manager = app.state::<AppSettingsManager>();
    let workflow =
        crate::services::flow::workflow::commands::get_workflow_by_id(&manager, &automation.id)?;
    Ok(workflow
        .and_then(|workflow| workflow.watcher_glob_pattern())
        .map(|patterns| {
            patterns
                .split(',')
                .map(str::trim)
                .filter(|pattern| !pattern.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

fn start_watch_session(
    automation: &Automation,
    config: WatchConfig,
    app: AppHandle,
) -> Result<WatchSession, String> {
    let paths = local_paths(automation);
    if paths.is_empty() {
        return Err(crate::localized_error!(
            "backendErrors.automation.noLocalPaths"
        ));
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<notify::Result<Event>>(200);
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            let _ = tx.blocking_send(event);
        },
        notify::Config::default(),
    )
    .map_err(|error| crate::localized_error!("backendErrors.automation.executionFailed", "error" => error))?;
    let pending: Vec<String> = paths
        .iter()
        .filter(|path| {
            watcher
                .watch(Path::new(path), RecursiveMode::Recursive)
                .is_err()
        })
        .cloned()
        .collect();
    let pending_roots: PendingRoots = Arc::new(parking_lot::Mutex::new(pending));
    let task = crate::utils::spawn(watch_loop(
        app,
        automation.id.clone(),
        config.clone(),
        paths,
        rx,
        watcher,
        pending_roots.clone(),
    ));
    Ok(WatchSession {
        config,
        task,
        pending_roots,
    })
}

/// Past this many waiting paths the individual changes are dropped in favor of the roots:
/// syncing every root covers them all, and the set no longer grows with the size of the change.
const MAX_TRACKED_CHANGES: usize = 10_000;

/// Changed paths waiting for their quiet period, and the ones handed to the running automation.
struct Changes {
    roots: Vec<PathBuf>,
    waiting: HashSet<PathBuf>,
    last_change: Option<Instant>,
    submitted: HashSet<PathBuf>,
}

impl Changes {
    fn new(roots: &[String]) -> Self {
        Self {
            roots: roots.iter().map(PathBuf::from).collect(),
            waiting: HashSet::new(),
            last_change: None,
            submitted: HashSet::new(),
        }
    }

    fn add(&mut self, paths: impl IntoIterator<Item = PathBuf>) {
        self.waiting.extend(paths);
        if self.waiting.len() > MAX_TRACKED_CHANGES {
            self.waiting = self.roots.iter().cloned().collect();
        }
        self.last_change = Some(Instant::now());
    }

    fn is_quiet(&self, delay: u64) -> bool {
        self.last_change
            .is_some_and(|time| time.elapsed() >= Duration::from_secs(delay))
    }

    /// Hands out the waiting paths; they come back through `retry` if the run does not happen.
    fn submit(&mut self) -> HashSet<PathBuf> {
        self.submitted = std::mem::take(&mut self.waiting);
        self.submitted.clone()
    }

    fn retry(&mut self) {
        let submitted = std::mem::take(&mut self.submitted);
        self.add(submitted);
    }
}

async fn watch_loop(
    app: AppHandle,
    id: String,
    config: WatchConfig,
    roots: Vec<String>,
    mut events: tokio::sync::mpsc::Receiver<notify::Result<Event>>,
    mut watcher: RecommendedWatcher,
    pending_roots: PendingRoots,
) {
    let globs = compile_globs(&config.patterns);
    let mut changes = Changes::new(&roots);
    let mut in_flight: Option<tokio::task::JoinHandle<Result<bool, String>>> = None;
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        // An idle session has nothing to look at, so it does not wake up.
        let busy =
            !changes.waiting.is_empty() || in_flight.is_some() || !pending_roots.lock().is_empty();
        tokio::select! {
            event = events.recv() => match event {
                None => break,
                Some(event) => record_event(event, &roots, &globs, &mut watcher, &pending_roots, &mut changes, &id),
            },
            _ = tick.tick(), if busy => {
                retry_missing_roots(&mut watcher, &pending_roots, &mut changes);
                settle_run(&mut in_flight, &mut changes, &id).await;
                if in_flight.is_some() || !changes.is_quiet(config.delay) || changes.waiting.is_empty() {
                    continue;
                }
                if !start_run(&app, &id, &config, &mut changes, &mut in_flight).await {
                    break;
                }
            }
        }
    }
}

fn record_event(
    event: notify::Result<Event>,
    roots: &[String],
    globs: &[Glob],
    watcher: &mut RecommendedWatcher,
    pending_roots: &PendingRoots,
    changes: &mut Changes,
    id: &str,
) {
    let event = match event {
        Ok(event) => event,
        Err(error) => {
            // The OS may have dropped events, so anything under a root could have changed.
            log::error!("Watcher {id}: {error}");
            changes.add(roots.iter().map(PathBuf::from));
            return;
        }
    };
    if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
        return;
    }
    // A root can only vanish through an event on itself or on one of its parents.
    for root in roots {
        let affected = event
            .paths
            .iter()
            .any(|path| Path::new(root).starts_with(path));
        if affected && !Path::new(root).exists() {
            let mut pending = pending_roots.lock();
            if !pending.contains(root) {
                let _ = watcher.unwatch(Path::new(root));
                pending.push(root.clone());
            }
        }
    }
    let accepted: Vec<PathBuf> = event
        .paths
        .into_iter()
        .filter(|path| accepts_path(path, roots, globs))
        .collect();
    if !accepted.is_empty() {
        changes.add(accepted);
    }
}

/// A later mkdir of a missing root is picked up without another settings edit.
fn retry_missing_roots(
    watcher: &mut RecommendedWatcher,
    pending_roots: &PendingRoots,
    changes: &mut Changes,
) {
    pending_roots.lock().retain(|path| {
        if watcher
            .watch(Path::new(path), RecursiveMode::Recursive)
            .is_err()
        {
            return true;
        }
        changes.add([PathBuf::from(path)]);
        false
    });
}

/// Collects the finished run; changes of a run that did not happen are queued again.
async fn settle_run(
    in_flight: &mut Option<tokio::task::JoinHandle<Result<bool, String>>>,
    changes: &mut Changes,
    id: &str,
) {
    if !in_flight.as_ref().is_some_and(|task| task.is_finished()) {
        return;
    }
    let Some(task) = in_flight.take() else {
        return;
    };
    let result = task.await;
    if matches!(result, Ok(Ok(true))) {
        changes.submitted.clear();
        return;
    }
    changes.retry();
    if let Ok(Err(error)) = result {
        log::error!("Watcher {id}: {error}");
    }
}

/// Starts the automation for the waiting changes. `false` ends the session: the automation
/// is gone or its arguments changed, and `sync_watchers` starts a fresh session if needed.
async fn start_run(
    app: &AppHandle,
    id: &str,
    config: &WatchConfig,
    changes: &mut Changes,
    in_flight: &mut Option<tokio::task::JoinHandle<Result<bool, String>>>,
) -> bool {
    let Some(automation) = app.state::<AutomationsCache>().get_automation(id).await else {
        return false;
    };
    if automation.args != config.args {
        return false;
    }
    if is_busy_or_cooling_down(&automation, app).await {
        return true;
    }
    let trigger = WatchTrigger {
        args: config.args.clone(),
        changed_paths: changes.submit(),
    };
    let (app, id) = (app.clone(), id.to_owned());
    *in_flight = Some(crate::utils::spawn(async move {
        execute_automation(&id, &app, Some(trigger)).await
    }));
    true
}

/// One include/exclude pattern, split into path segments once instead of once per event.
struct Glob {
    exclude: bool,
    parts: Vec<GlobPart>,
}

enum GlobPart {
    AnyDirectories,
    Name(Vec<char>),
}

fn compile_globs(patterns: &[String]) -> Vec<Glob> {
    patterns
        .iter()
        .map(|pattern| {
            let (exclude, pattern) = match pattern.strip_prefix('!') {
                Some(rest) => (true, rest.trim()),
                None => (false, pattern.as_str()),
            };
            let pattern = pattern.replace('\\', "/");
            let effective = if pattern.starts_with('/') {
                pattern.trim_start_matches('/').to_string()
            } else {
                format!("**/{pattern}")
            };
            let parts = effective
                .split('/')
                .filter(|part| !part.is_empty())
                .map(|part| match part {
                    "**" => GlobPart::AnyDirectories,
                    name => GlobPart::Name(name.chars().collect()),
                })
                .collect();
            Glob { exclude, parts }
        })
        .collect()
}

fn accepts_path(path: &Path, roots: &[String], globs: &[Glob]) -> bool {
    let Some(relative) = roots.iter().find_map(|root| path.strip_prefix(root).ok()) else {
        return false;
    };
    if globs.is_empty() {
        return true;
    }
    let relative = relative.to_string_lossy().replace('\\', "/");
    let segments: Vec<&str> = relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mut has_include = false;
    let mut included = false;
    for glob in globs {
        let matches = match_parts(&glob.parts, &segments);
        if glob.exclude {
            if matches {
                return false;
            }
        } else {
            has_include = true;
            included |= matches;
        }
    }
    !has_include || included
}

fn match_parts(pattern: &[GlobPart], segments: &[&str]) -> bool {
    match pattern {
        [] => segments.is_empty(),
        [GlobPart::AnyDirectories] => true,
        [GlobPart::AnyDirectories, rest @ ..] => {
            (0..=segments.len()).any(|skip| match_parts(rest, &segments[skip..]))
        }
        [GlobPart::Name(name), rest @ ..] => match segments {
            [] => false,
            [segment, tail @ ..] => match_wildcard(name, segment) && match_parts(rest, tail),
        },
    }
}

/// `*` matches any run of characters and `?` exactly one, within one path segment.
fn match_wildcard(pattern: &[char], text: &str) -> bool {
    let (mut pi, mut ti) = (0, 0);
    // Where to resume in the pattern and in the text when the last `*` has to take one more character.
    let mut star: Option<(usize, usize)> = None;
    while let Some(c) = text[ti..].chars().next() {
        if pi < pattern.len() && (pattern[pi] == '?' || pattern[pi] == c) {
            pi += 1;
            ti += c.len_utf8();
        } else if pi < pattern.len() && pattern[pi] == '*' {
            star = Some((pi + 1, ti));
            pi += 1;
        } else if let Some((star_pi, star_ti)) = star {
            let next = star_ti + text[star_ti..].chars().next().map_or(1, char::len_utf8);
            star = Some((star_pi, next));
            pi = star_pi;
            ti = next;
        } else {
            return false;
        }
    }
    pattern[pi..].iter().all(|&c| c == '*')
}

/// The source/destination directory pairs a changed-only run has to sync: every directory
/// that holds a change, without the ones a changed parent directory already covers.
pub fn compute_scoped_targets(
    src_paths: &[String],
    dst_paths: &[String],
    changed_paths: &HashSet<PathBuf>,
) -> Vec<(String, String)> {
    if changed_paths.is_empty() || src_paths.is_empty() {
        return Vec::new();
    }

    // (index of the source root, directory relative to it); "" is the root itself.
    let mut dirs: HashSet<(usize, String)> = HashSet::new();
    for changed in changed_paths {
        let Some((idx, src_root)) = src_paths
            .iter()
            .enumerate()
            .find(|(_, src)| changed.starts_with(src))
        else {
            continue;
        };
        let Ok(rel_path) = changed.strip_prefix(src_root) else {
            continue;
        };
        let rel_dir = if changed.is_dir() {
            rel_path.to_string_lossy()
        } else {
            rel_path
                .parent()
                .map(|p| p.to_string_lossy())
                .unwrap_or_default()
        };
        dirs.insert((
            idx,
            rel_dir.replace('\\', "/").trim_matches('/').to_string(),
        ));
    }

    let default_dst = dst_paths.first().cloned().unwrap_or_default();
    let mut result: Vec<(String, String)> = dirs
        .iter()
        .filter(|(idx, dir)| !is_covered(&dirs, *idx, dir))
        .map(|(idx, rel_dir)| {
            let src_root = &src_paths[*idx];
            let dst_root = dst_paths.get(*idx).unwrap_or(&default_dst);
            if rel_dir.is_empty() {
                (src_root.clone(), dst_root.clone())
            } else {
                (
                    build_full_path(src_root, rel_dir),
                    build_full_path(dst_root, rel_dir),
                )
            }
        })
        .collect();
    result.sort();
    result
}

/// Whether a parent of `dir` (or the root) is itself being synced, which includes `dir`.
fn is_covered(dirs: &HashSet<(usize, String)>, idx: usize, dir: &str) -> bool {
    !dir.is_empty()
        && (dirs.contains(&(idx, String::new()))
            || dir
                .match_indices('/')
                .any(|(end, _)| dirs.contains(&(idx, dir[..end].to_string()))))
}

fn local_paths(automation: &Automation) -> Vec<String> {
    let mut paths: Vec<String> = automation
        .args
        .src_paths
        .iter()
        .filter(|p| is_local_path(p))
        .cloned()
        .collect();

    if automation.automation_type == OperationType::Bisync {
        paths.extend(
            automation
                .args
                .dst_paths
                .iter()
                .filter(|p| is_local_path(p))
                .cloned(),
        );
    }

    paths
}

/// An automation that runs, ran a moment ago, or has a matching job running or just finished
/// is left alone; the changes stay queued and the next look at them retries.
async fn is_busy_or_cooling_down(automation: &Automation, app: &AppHandle) -> bool {
    if matches!(
        automation.status,
        AutomationStatus::Running | AutomationStatus::Stopping
    ) {
        return true;
    }
    let cooling_down = |time: DateTime<Utc>| {
        Utc::now().signed_duration_since(time) < chrono::Duration::seconds(COOLDOWN_SECS)
    };
    if automation.last_run.is_some_and(cooling_down) {
        return true;
    }
    // A serve quick run starts a serve, not a job.
    let Some(job_type) = automation.automation_type.as_job_type() else {
        return false;
    };
    let Some(backend_manager) = app.try_state::<BackendManager>() else {
        return false;
    };
    let activity = backend_manager
        .job_cache_for(&automation.backend_name)
        .job_activity(
            &automation.args.params.remote_name,
            &job_type,
            Some(automation.args.params.profile_name.as_str()),
        )
        .await;
    activity.running || activity.last_finished.is_some_and(cooling_down)
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn watch_fixture(
        root: &std::path::Path,
        source: &std::path::Path,
    ) -> (AppHandle, String) {
        use crate::rclone::backend::{routing_transport::RoutingTransport, types::Backend};
        use crate::services::settings::schema::AppSettings;
        let settings: AppSettingsManager = rcman::SettingsManager::builder("watch-test", "1.0.0")
            .with_config_dir(root.join("settings"))
            .with_schema::<AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .build()
            .unwrap();
        let manager = BackendManager::new();
        let mut backend = Backend::new_local("Local");
        backend.port = 0;
        manager.update("Local", backend).await.unwrap();
        let config: crate::utils::types::remotes::RemoteSettings = serde_json::from_value(serde_json::json!({
            "name":"drive", "syncConfigs":{"Default": {"app":{"watchEnabled":true,"watchDelay":0}, "rclone":{"srcFs":source,"dstFs":"drive:"}}}
        })).unwrap();
        settings
            .sub_settings("remotes")
            .unwrap()
            .set("drive", &config)
            .unwrap();
        let cache = AutomationsCache::new();
        let automation = cache
            .add_or_update_automation_for_remote("Local", "drive", &config)
            .await
            .unwrap()
            .added
            .remove(0);
        cache
            .update_automation(&automation.id, |automation| {
                automation.mark_starting().unwrap();
                automation.current_job_id = Some("busy".into());
            })
            .await
            .unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(settings);
        app.manage(cache);
        app.manage(WatcherManager::new());
        app.manage(crate::utils::types::state::RcloneState::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(100))
                .build()
                .unwrap(),
            Arc::new(RoutingTransport::new(app.clone())),
        ));
        (app, automation.id)
    }

    #[tokio::test]
    async fn watcher_replaces_changed_sessions_and_retries_missing_roots() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let (app, id) = watch_fixture(root.path(), &source).await;
        let manager = app.state::<WatcherManager>();
        manager.sync_watchers(app.clone()).await.unwrap();
        let original = manager.sessions.read().await[&id].task.abort_handle();
        let missing = root.path().join("later");
        app.state::<AutomationsCache>()
            .update_automation(&id, |automation| {
                automation.args.src_paths = vec![missing.to_string_lossy().to_string()];
                automation.watch_delay = 7;
            })
            .await
            .unwrap();
        assert!(manager.sync_watchers(app.clone()).await.is_err());
        tokio::task::yield_now().await;
        assert!(original.is_finished());
        assert_eq!(manager.sessions.read().await[&id].config.delay, 7);
        std::fs::create_dir(&missing).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if manager.sessions.read().await[&id]
                    .pending_roots
                    .lock()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        manager.sync_watchers(app.clone()).await.unwrap();
        std::fs::remove_dir(&missing).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if !manager.sessions.read().await[&id]
                    .pending_roots
                    .lock()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        std::fs::create_dir(&missing).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if manager.sessions.read().await[&id]
                    .pending_roots
                    .lock()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        manager.stop_all().await;
    }

    #[tokio::test]
    async fn a_session_whose_task_died_is_started_again() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let (app, id) = watch_fixture(root.path(), &source).await;
        let manager = app.state::<WatcherManager>();
        manager.sync_watchers(app.clone()).await.unwrap();
        let dead = manager.sessions.read().await[&id].task.abort_handle();
        dead.abort();
        tokio::task::yield_now().await;
        assert!(dead.is_finished());
        manager.sync_watchers(app.clone()).await.unwrap();
        assert!(!manager.sessions.read().await[&id].task.is_finished());
        manager.stop_all().await;
    }

    #[tokio::test]
    async fn busy_and_cooldown_changes_are_retried_without_a_second_file_event() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let (app, id) = watch_fixture(root.path(), &source).await;
        let manager = app.state::<WatcherManager>();
        manager.sync_watchers(app.clone()).await.unwrap();
        std::fs::write(source.join("changed.txt"), "data").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        let cache = app.state::<AutomationsCache>();
        assert_eq!(cache.get_automation(&id).await.unwrap().run_count, 1);
        cache
            .update_automation(&id, Automation::mark_success)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        assert_eq!(cache.get_automation(&id).await.unwrap().run_count, 1);
        // No daemon is listening at port 0. The attempt must still be made after
        // cooldown, proving the original event survived; its RPC error is expected.
        tokio::time::timeout(std::time::Duration::from_secs(7), async {
            loop {
                if cache.get_automation(&id).await.unwrap().run_count > 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        manager.stop_all().await;
    }

    #[test]
    fn test_compute_scoped_targets() {
        let src_paths = vec!["/home/user/backup".to_string()];
        let dst_paths = vec!["google:test1".to_string()];

        let mut changed = std::collections::HashSet::new();
        changed.insert(std::path::PathBuf::from(
            "/home/user/backup/proj/app/main.rs",
        ));
        changed.insert(std::path::PathBuf::from(
            "/home/user/backup/proj/app/lib.rs",
        ));
        changed.insert(std::path::PathBuf::from("/home/user/backup/other/doc.txt"));

        let targets = compute_scoped_targets(&src_paths, &dst_paths, &changed);
        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[0],
            (
                "/home/user/backup/other".to_string(),
                "google:test1/other".to_string()
            )
        );
        assert_eq!(
            targets[1],
            (
                "/home/user/backup/proj/app".to_string(),
                "google:test1/proj/app".to_string()
            )
        );
    }

    #[test]
    fn nested_changed_directories_are_covered_by_their_changed_parent() {
        let src = vec!["/r".to_string()];
        let dst = vec!["d:".to_string()];
        let changed = |paths: &[&str]| paths.iter().map(PathBuf::from).collect::<HashSet<_>>();
        // a/b/c.txt lies under a/x.txt's directory a, so only a is synced; a-b is a sibling.
        let targets = compute_scoped_targets(
            &src,
            &dst,
            &changed(&[
                "/r/a/x.txt",
                "/r/a/b/c.txt",
                "/r/a-b/y.txt",
                "/r/a/b/e/f.txt",
            ]),
        );
        assert_eq!(
            targets,
            vec![
                ("/r/a".to_string(), "d:/a".to_string()),
                ("/r/a-b".to_string(), "d:/a-b".to_string()),
            ]
        );
        // A change in the root covers everything below it.
        let targets = compute_scoped_targets(&src, &dst, &changed(&["/r/top.txt", "/r/a/x.txt"]));
        assert_eq!(targets, vec![("/r".to_string(), "d:".to_string())]);
    }

    #[test]
    fn too_many_changes_collapse_into_the_roots() {
        let mut changes = Changes::new(&["/r".to_string(), "/s".to_string()]);
        changes.add((0..MAX_TRACKED_CHANGES + 1).map(|n| PathBuf::from(format!("/r/{n}"))));
        assert_eq!(
            changes.waiting,
            HashSet::from([PathBuf::from("/r"), PathBuf::from("/s")])
        );
        changes.add([PathBuf::from("/r/a")]);
        assert_eq!(changes.waiting.len(), 3);
        assert!(changes.last_change.is_some());
    }

    #[test]
    fn test_compute_scoped_targets_root_file() {
        let src_paths = vec!["/home/user/backup".to_string()];
        let dst_paths = vec!["google:test1".to_string()];

        let mut changed = std::collections::HashSet::new();
        changed.insert(std::path::PathBuf::from("/home/user/backup/notes.txt"));

        let targets = compute_scoped_targets(&src_paths, &dst_paths, &changed);
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0],
            ("/home/user/backup".to_string(), "google:test1".to_string())
        );
    }
    #[test]
    fn workflow_patterns_and_remote_roots_are_respected() {
        let roots = vec!["/src".to_string()];
        let globs = compile_globs(&["*.txt".to_string(), "!secret*".to_string()]);
        assert!(accepts_path(Path::new("/src/a.txt"), &roots, &globs));
        assert!(accepts_path(
            Path::new("/src/deep/dir/a.txt"),
            &roots,
            &globs
        ));
        assert!(!accepts_path(Path::new("/src/secret.txt"), &roots, &globs));
        assert!(!accepts_path(Path::new("/src/a.log"), &roots, &globs));
        assert!(!accepts_path(Path::new("/src-old/a.txt"), &roots, &[]));
        assert!(accepts_path(Path::new("/src/anything.bin"), &roots, &[]));
    }

    #[test]
    fn globs_anchor_wildcards_and_unicode() {
        let roots = vec!["/src".to_string()];
        let accepts = |pattern: &str, path: &str| {
            accepts_path(
                Path::new(path),
                &roots,
                &compile_globs(&[pattern.to_string()]),
            )
        };
        // A leading slash anchors the pattern to the root.
        assert!(accepts("/docs/*.md", "/src/docs/a.md"));
        assert!(!accepts("/docs/*.md", "/src/x/docs/a.md"));
        assert!(accepts("docs/*.md", "/src/x/docs/a.md"));
        assert!(accepts("**/build/**", "/src/a/build/out/x.o"));
        assert!(accepts("file?.txt", "/src/file1.txt"));
        assert!(!accepts("file?.txt", "/src/file12.txt"));
        assert!(accepts("*é*", "/src/café.txt"));
        assert!(accepts("caf?.txt", "/src/café.txt"));
        assert!(accepts("a*b*c", "/src/aXXbYYc"));
        assert!(!accepts("a*b*c", "/src/aXXbYY"));
        // Backslashes in the pattern and the path are separators.
        assert!(accepts("docs\\*.md", "/src/docs/a.md"));
    }

    #[tokio::test]
    async fn a_serve_quick_run_has_no_job_to_wait_for() {
        use crate::rclone::backend::BackendManager;
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        let args = AutomationArgs {
            params: crate::utils::types::remotes::ProfileParams {
                remote_name: "drive:".into(),
                profile_name: "serve".into(),
                backend_name: None,
                source: Some(Origin::QuickRun),
                no_cache: None,
                scoped_targets: None,
                execute_id: None,
            },
            src_paths: vec!["/tmp".into()],
            dst_paths: Vec::new(),
        };
        let mut automation = Automation::new("qr".into(), OperationType::Serve, args, "Local");
        assert!(!is_busy_or_cooling_down(&automation, &app).await);
        // The automation's own state still counts.
        automation.status = AutomationStatus::Running;
        assert!(is_busy_or_cooling_down(&automation, &app).await);
        automation.status = AutomationStatus::Enabled;
        automation.last_run = Some(Utc::now());
        assert!(is_busy_or_cooling_down(&automation, &app).await);
    }
}
