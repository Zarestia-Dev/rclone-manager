use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::rclone::state::automations::AutomationsCache;
use crate::rclone::state::cache::is_local_path;
use crate::services::automation::engine::{WatchTrigger, execute_automation};
use crate::services::settings::AppSettingsManager;
use crate::utils::json_helpers::build_full_path;
use crate::utils::types::automation::{Automation, AutomationArgs, AutomationStatus};
use crate::utils::types::remotes::OperationType;
use chrono::Utc;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

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
    pending_roots: Arc<Mutex<Vec<String>>>,
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
            let patterns = if automation.args.params.source
                == Some(crate::utils::types::origin::Origin::Flow)
            {
                let manager = app.state::<AppSettingsManager>();
                crate::services::flow::workflow::commands::get_workflow_by_id(
                    &manager,
                    &automation.id,
                )?
                .and_then(|workflow| workflow.watcher_glob_pattern())
                .map(|patterns| {
                    patterns
                        .split(',')
                        .map(str::trim)
                        .filter(|p| !p.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
            } else {
                Vec::new()
            };
            let config = WatchConfig {
                args: automation.args.clone(),
                operation: automation.automation_type,
                delay: automation.watch_delay,
                changed_only: automation.watch_changed_only,
                patterns,
            };
            if sessions
                .get(&automation.id)
                .is_none_or(|session| session.config != config)
            {
                // Drop the old loop before replacement, including its buffered events.
                sessions.remove(&automation.id);
                match Self::start_watch_session(automation, config, app.clone()) {
                    Ok(session) => {
                        sessions.insert(automation.id.clone(), session);
                    }
                    Err(error) => {
                        errors.push(error);
                    }
                }
            }
            if let Some(session) = sessions.get(&automation.id) {
                let roots = session.pending_roots.lock().unwrap();
                if !roots.is_empty() {
                    errors.push(format!(
                        "{}: watcher pending for {}",
                        automation.id,
                        roots.join(", ")
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

    fn start_watch_session(
        automation: &Automation,
        config: WatchConfig,
        app: AppHandle,
    ) -> Result<WatchSession, String> {
        let paths = local_paths(automation);
        if paths.is_empty() {
            return Err(
                crate::localized_error!("backendErrors.automation.executionFailed", "error" => "No local paths to watch"),
            );
        }
        let (tx, mut rx) = tokio::sync::mpsc::channel::<notify::Result<Event>>(200);
        let mut watcher = RecommendedWatcher::new(move |event| { let _ = tx.blocking_send(event); }, notify::Config::default())
            .map_err(|error| crate::localized_error!("backendErrors.automation.executionFailed", "error" => error))?;
        let mut pending = Vec::new();
        for path in &paths {
            if watcher
                .watch(std::path::Path::new(path), RecursiveMode::Recursive)
                .is_err()
            {
                pending.push(path.clone());
            }
        }
        let pending_roots = Arc::new(Mutex::new(pending));
        let pending_for_task = pending_roots.clone();
        let id = automation.id.clone();
        let expected = config.clone();
        let task = crate::utils::spawn(async move {
            let mut changed = HashSet::<PathBuf>::new();
            let mut last_change: Option<std::time::Instant> = None;
            let mut in_flight: Option<tokio::task::JoinHandle<Result<bool, String>>> = None;
            let mut submitted = HashSet::new();
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
            loop {
                tokio::select! {
                    event = rx.recv() => {
                        match event {
                            None => break,
                            Some(Err(error)) => { log::error!("Watcher {id}: {error}"); changed.extend(paths.iter().map(PathBuf::from)); last_change = Some(std::time::Instant::now()); }
                            Some(Ok(event)) => {
                                if matches!(event.kind, notify::EventKind::Access(_) | notify::EventKind::Other) { continue; }
                                for root in &paths {
                                    if !std::path::Path::new(root).exists() {
                                        let mut pending = pending_for_task.lock().unwrap();
                                        if !pending.contains(root) {
                                            let _ = watcher.unwatch(std::path::Path::new(root));
                                            pending.push(root.clone());
                                        }
                                    }
                                }
                                for path in event.paths {
                                    if accepts_path(&path, &paths, &expected.patterns) { changed.insert(path); last_change = Some(std::time::Instant::now()); }
                                }
                            }
                        }
                    }
                    _ = tick.tick() => {
                        // Keep a session alive for missing roots. A later mkdir is
                        // applied without requiring another settings edit.
                        pending_for_task.lock().unwrap().retain(|path| {
                            if watcher.watch(std::path::Path::new(path), RecursiveMode::Recursive).is_err() { return true; }
                            changed.insert(PathBuf::from(path));
                            last_change = Some(std::time::Instant::now());
                            false
                        });
                        if in_flight.as_ref().is_some_and(|task| task.is_finished()) {
                            let result = in_flight.take().unwrap().await;
                            if !matches!(result, Ok(Ok(true))) {
                                changed.extend(std::mem::take(&mut submitted));
                                last_change = Some(std::time::Instant::now());
                                if let Ok(Err(error)) = result { log::error!("Watcher {id}: {error}"); }
                            } else { submitted.clear(); }
                        }
                        if in_flight.is_some() || changed.is_empty() || last_change.is_none_or(|time| time.elapsed() < std::time::Duration::from_secs(expected.delay)) { continue; }
                        let Some(automation) = app.state::<AutomationsCache>().get_automation(&id).await else { break };
                        if automation.args != expected.args { break; }
                        if is_automation_running_or_in_cooldown(&automation, &app).await { continue; }
                        submitted = std::mem::take(&mut changed);
                        let trigger = WatchTrigger { args: expected.args.clone(), changed_paths: submitted.clone() };
                        let execution_app = app.clone(); let execution_id = id.clone();
                        in_flight = Some(crate::utils::spawn(async move { execute_automation(&execution_id, &execution_app, Some(trigger)).await }));
                    }
                }
            }
        });
        Ok(WatchSession {
            config,
            task,
            pending_roots,
        })
    }
}

impl Default for WatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

fn accepts_path(path: &std::path::Path, roots: &[String], patterns: &[String]) -> bool {
    let Some(relative) = roots.iter().find_map(|root| path.strip_prefix(root).ok()) else {
        return false;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    let mut has_include = false;
    let mut included = false;
    for pattern in patterns {
        if let Some(exclude) = pattern.strip_prefix('!') {
            if glob_match(exclude.trim(), &relative, false) {
                return false;
            }
        } else {
            has_include = true;
            included |= glob_match(pattern, &relative, false);
        }
    }
    !has_include || included
}

pub fn compute_scoped_targets(
    src_paths: &[String],
    dst_paths: &[String],
    changed_paths: &std::collections::HashSet<std::path::PathBuf>,
) -> Vec<(String, String)> {
    if changed_paths.is_empty() || src_paths.is_empty() {
        return Vec::new();
    }

    let default_dst = dst_paths.first().cloned().unwrap_or_default();
    let mut scoped_pairs = std::collections::HashSet::new();

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

        let rel_dir = rel_dir.replace('\\', "/").trim_matches('/').to_string();
        let target_dst_root = dst_paths.get(idx).unwrap_or(&default_dst);

        let (scoped_src, scoped_dst) = if rel_dir.is_empty() {
            (src_root.clone(), target_dst_root.clone())
        } else {
            (
                build_full_path(src_root, &rel_dir),
                build_full_path(target_dst_root, &rel_dir),
            )
        };

        scoped_pairs.insert((scoped_src, scoped_dst));
    }

    let mut result: Vec<(String, String)> = scoped_pairs.into_iter().collect();
    result.sort();
    result
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

async fn is_automation_running_or_in_cooldown(
    automation: &Automation,
    app_handle: &AppHandle,
) -> bool {
    if matches!(
        automation.status,
        AutomationStatus::Running | AutomationStatus::Stopping
    ) {
        return true;
    }

    if automation
        .last_run
        .is_some_and(|lr| Utc::now().signed_duration_since(lr) < chrono::Duration::seconds(5))
    {
        return true;
    }

    let Some(backend_manager) = app_handle.try_state::<BackendManager>() else {
        return false;
    };

    let job_cache = backend_manager.job_cache_for(&automation.backend_name);
    let remote_name = automation.args.params.remote_name.trim_end_matches(':');
    let job_type = automation.automation_type.as_job_type().unwrap();
    let profile = Some(automation.args.params.profile_name.as_str());

    let active_jobs = job_cache.get_active_jobs().await;
    if active_jobs.iter().any(|j| {
        j.remote_name.trim_end_matches(':') == remote_name
            && j.job_type == job_type
            && j.profile.as_deref() == profile
    }) {
        return true;
    }

    // Check 5-second cooldown after the most recent matching finished job.
    let finished_jobs = job_cache.get_jobs().await;
    let last_finished = finished_jobs
        .iter()
        .filter(|j| {
            j.remote_name.trim_end_matches(':') == remote_name
                && j.job_type == job_type
                && j.profile.as_deref() == profile
        })
        .filter_map(|j| j.end_time)
        .max();

    last_finished
        .is_some_and(|t| Utc::now().signed_duration_since(t) < chrono::Duration::seconds(5))
}

fn glob_match(pattern: &str, path: &str, ignore_case: bool) -> bool {
    let normalize = |s: &str| {
        let s = s.replace('\\', "/");
        if ignore_case { s.to_lowercase() } else { s }
    };

    let pattern = normalize(pattern);
    let path = normalize(path);
    let is_anchored = pattern.starts_with('/');

    let effective_pattern = if is_anchored {
        pattern.trim_start_matches('/').to_string()
    } else {
        format!("**/{}", pattern.trim_start_matches('/'))
    };

    let p_parts: Vec<&str> = effective_pattern
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let s_parts: Vec<&str> = path
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    fn match_parts(p: &[&str], s: &[&str]) -> bool {
        match p {
            [] => s.is_empty(),
            ["**"] => true,
            ["**", rest @ ..] => (0..=s.len()).any(|i| match_parts(rest, &s[i..])),
            [pat, rest @ ..] => match s {
                [] => false,
                [seg, tail @ ..] => match_wildcard(pat, seg) && match_parts(rest, tail),
            },
        }
    }

    fn match_wildcard(pattern: &str, s: &str) -> bool {
        let p: Vec<char> = pattern.chars().collect();
        let s: Vec<char> = s.chars().collect();
        let mut pi = 0;
        let mut si = 0;
        let mut star_pi = None;
        let mut star_si = 0;

        while si < s.len() {
            if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
                pi += 1;
                si += 1;
            } else if pi < p.len() && p[pi] == '*' {
                star_pi = Some(pi);
                star_si = si;
                pi += 1;
            } else if let Some(spi) = star_pi {
                pi = spi + 1;
                star_si += 1;
                si = star_si;
            } else {
                return false;
            }
        }

        while pi < p.len() && p[pi] == '*' {
            pi += 1;
        }
        pi == p.len()
    }

    match_parts(&p_parts, &s_parts)
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
        manager.update(&settings, "Local", backend).await.unwrap();
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
                    .unwrap()
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
                    .unwrap()
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
                    .unwrap()
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
        let patterns = vec!["*.txt".to_string(), "!secret*".to_string()];
        assert!(accepts_path(
            std::path::Path::new("/src/a.txt"),
            &roots,
            &patterns
        ));
        assert!(!accepts_path(
            std::path::Path::new("/src/secret.txt"),
            &roots,
            &patterns
        ));
        assert!(!accepts_path(
            std::path::Path::new("/src/a.log"),
            &roots,
            &patterns
        ));
        assert!(!accepts_path(
            std::path::Path::new("/src-old/a.txt"),
            &roots,
            &[]
        ));
    }
}
