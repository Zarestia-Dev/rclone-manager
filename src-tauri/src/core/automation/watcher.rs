use crate::core::automation::engine::execute_automation;
use crate::rclone::backend::BackendManager;
use crate::rclone::state::automations::AutomationsCache;
use crate::rclone::state::cache::is_local_path;
use crate::utils::types::automation::{Automation, AutomationStatus};
use crate::utils::types::remotes::OperationType;
use chrono::Utc;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

pub struct WatchSession {
    _watcher: RecommendedWatcher,
}

pub struct WatcherManager {
    sessions: Arc<RwLock<HashMap<String, WatchSession>>>,
}

impl WatcherManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Sync active watchers with the automations cache.
    /// File watchers only work on local backends — on remote backends we stop all sessions.
    pub async fn sync_watchers(&self, app_handle: AppHandle) -> Result<(), String> {
        // File watchers can only monitor the local filesystem.
        // On remote backends, stop any existing sessions and return early.
        let backend_manager = app_handle.state::<BackendManager>();
        if !backend_manager.is_active_local().await {
            let mut sessions = self.sessions.write().await;
            if !sessions.is_empty() {
                log::info!("Active backend is remote — stopping all file watchers");
                sessions.clear();
            }
            return Ok(());
        }

        let cache = app_handle.state::<AutomationsCache>();
        let automations = cache.get_all_automations().await;
        let mut sessions = self.sessions.write().await;

        let active_ids: std::collections::HashSet<String> = automations
            .iter()
            .filter(|a| a.watch_enabled && a.status != AutomationStatus::Disabled)
            .map(|a| a.id.clone())
            .collect();

        for automation in &automations {
            if !active_ids.contains(&automation.id) || sessions.contains_key(&automation.id) {
                continue;
            }
            match self
                .start_watch_session(automation, app_handle.clone())
                .await
            {
                Ok(session) => {
                    sessions.insert(automation.id.clone(), session);
                    log::info!("Started watcher for automation: {}", automation.id);
                }
                Err(e) => {
                    log::error!(
                        "Failed to start watcher for automation {}: {}",
                        automation.id,
                        e
                    );
                }
            }
        }

        sessions.retain(|id, _| {
            if active_ids.contains(id) {
                return true;
            }
            log::info!("Stopped watcher for automation: {id}");
            false
        });

        Ok(())
    }

    /// Stop all active watch sessions.
    pub async fn stop_all(&self) {
        self.sessions.write().await.clear();
        log::info!("Stopped all filesystem watchers");
    }

    async fn start_watch_session(
        &self,
        automation: &Automation,
        app_handle: AppHandle,
    ) -> Result<WatchSession, String> {
        let paths = local_paths(automation);
        if paths.is_empty() {
            return Err("No local paths to watch for this automation".to_string());
        }

        let automation_id = automation.id.clone();
        let watch_delay = automation.watch_delay;

        let config_key = automation.automation_type.config_key();

        let filter_options = match crate::rclone::commands::common::resolve_profile_settings(
            &app_handle,
            &automation.remote_name,
            &automation.profile_name,
            config_key,
        )
        .await
        {
            Ok((config, settings)) => {
                crate::rclone::commands::common::parse_common_config(&config, &settings)
                    .and_then(|c| c.filter_options)
                    .map(|opts| resolve_filter_options(&opts))
            }
            Err(e) => {
                log::debug!(
                    "Could not resolve filter options for automation {}: {e}",
                    automation.id
                );
                None
            }
        };

        let (tx, mut rx) = tokio::sync::mpsc::channel::<notify::Result<Event>>(200);

        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.blocking_send(res);
            },
            notify::Config::default(),
        )
        .map_err(|e| format!("Failed to create watcher: {e}"))?;

        for p in &paths {
            let path = std::path::Path::new(p);
            if !path.exists() {
                return Err(format!("Path does not exist: {p}"));
            }
            watcher
                .watch(path, RecursiveMode::Recursive)
                .map_err(|e| format!("Failed to watch {p}: {e}"))?;
            log::info!("Watching: {p}");
        }

        let cache = app_handle.state::<AutomationsCache>().inner().clone();
        let paths_clone = paths.clone();

        tokio::spawn(async move {
            // Net-change tracking within the current debounce window:
            //
            // `created_in_window` tracks paths that were *created* since the window opened.
            // `changed_paths`     tracks paths with a net real change.
            //
            // When a Remove event arrives for a path that exists in `created_in_window`,
            // it means the file was born and died entirely within this window — net zero
            // change — so we cancel it out of both sets. This handles temp files, editor
            // swap files, atomic saves, and any other create-then-delete pattern without
            // needing to enumerate file name heuristics.
            let mut created_in_window: std::collections::HashSet<std::path::PathBuf> =
                std::collections::HashSet::new();
            let mut changed_paths: std::collections::HashSet<std::path::PathBuf> =
                std::collections::HashSet::new();
            let mut last_change: Option<std::time::Instant> = None;
            let mut tick = tokio::time::interval(tokio::time::Duration::from_millis(500));

            loop {
                tokio::select! {
                    event = rx.recv() => {
                        match event {
                            None => break, // watcher dropped, channel closed
                            Some(Err(e)) => log::error!("Watcher error for {automation_id}: {e}"),
                            Some(Ok(ev)) => {
                                if !is_relevant_event(&ev) {
                                    continue;
                                }

                                for path in &ev.paths {
                                    if is_path_filtered(path, &paths_clone, &filter_options) {
                                        continue;
                                    }

                                    match ev.kind {
                                        notify::EventKind::Create(_) => {
                                            created_in_window.insert(path.clone());
                                            changed_paths.insert(path.clone());
                                        }
                                        notify::EventKind::Remove(_) => {
                                            if created_in_window.remove(path) {
                                                // Created and deleted within the same debounce
                                                // window — net zero change, cancel it out.
                                                changed_paths.remove(path);
                                                log::debug!(
                                                    "Path {path:?} created and removed in debounce window — net zero, skipping"
                                                );
                                            } else {
                                                // Pre-existing file deleted — real change.
                                                changed_paths.insert(path.clone());
                                            }
                                        }
                                        _ => {
                                            changed_paths.insert(path.clone());
                                        }
                                    }
                                }

                                if !changed_paths.is_empty() {
                                    last_change = Some(std::time::Instant::now());
                                    log::debug!(
                                        "Net change detected for {automation_id}, {} path(s) pending",
                                        changed_paths.len()
                                    );
                                }
                            }
                        }
                    }

                    _ = tick.tick() => {
                        let Some(instant) = last_change else { continue; };
                        if instant.elapsed() < std::time::Duration::from_secs(watch_delay) {
                            continue;
                        }

                        last_change = None;

                        if changed_paths.is_empty() {
                            // All changes cancelled out (e.g. only temp files were touched).
                            log::debug!("Debounce expired for {automation_id} — all changes netted to zero, skipping");
                            continue;
                        }

                        created_in_window.clear();
                        changed_paths.clear();

                        let Some(a) = cache.get_automation(&automation_id).await else { continue; };
                        if is_automation_running_or_in_cooldown(&a, &app_handle).await {
                            log::debug!("Debounce expired for {automation_id} — automation is busy, skipping");
                            continue;
                        }

                        log::info!("Triggering automation {automation_id} after debounce");
                        let app_handle_clone = app_handle.clone();
                        let id_clone = automation_id.clone();
                        tokio::spawn(async move {
                            if let Err(e) = execute_automation(&id_clone, &app_handle_clone).await {
                                log::error!("Error executing automation {id_clone}: {e}");
                            }
                        });
                    }
                }
            }

            log::info!("Watch loop terminated for automation {automation_id}");
        });

        Ok(WatchSession { _watcher: watcher })
    }
}

impl Default for WatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// HELPERS
// ============================================================================

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

fn is_relevant_event(event: &Event) -> bool {
    !matches!(
        event.kind,
        notify::EventKind::Access(_) | notify::EventKind::Other
    )
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

    let job_cache = &backend_manager.job_cache;
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

// ============================================================================
// FILTER / PATTERN MATCHING
// ============================================================================

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

fn parse_rclone_size(s: &str) -> Option<u64> {
    let s = s.trim().to_lowercase();
    let (digits, unit) = s.split_at(
        s.find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(s.len()),
    );
    let val: f64 = digits.parse().ok()?;
    let multiplier = match unit.trim() {
        "k" | "kb" | "kib" => 1024.0_f64,
        "m" | "mb" | "mib" => 1024.0_f64.powi(2),
        "g" | "gb" | "gib" => 1024.0_f64.powi(3),
        "t" | "tb" | "tib" => 1024.0_f64.powi(4),
        "" | "b" => 1.0,
        _ => 1.0,
    };
    Some((val * multiplier) as u64)
}

fn parse_rclone_duration(s: &str) -> Option<chrono::Duration> {
    let s = s.trim().to_lowercase();
    let (digits, unit) = s.split_at(
        s.find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(s.len()),
    );
    let val: i64 = digits.parse().ok()?;
    match unit.trim() {
        "s" | "sec" | "second" | "seconds" => Some(chrono::Duration::seconds(val)),
        "m" | "min" | "minute" | "minutes" => Some(chrono::Duration::minutes(val)),
        "h" | "hr" | "hour" | "hours" => Some(chrono::Duration::hours(val)),
        "d" | "day" | "days" => Some(chrono::Duration::days(val)),
        "w" | "week" | "weeks" => Some(chrono::Duration::weeks(val)),
        "y" | "year" | "years" => Some(chrono::Duration::days((val as f64 * 365.25) as i64)),
        _ => None,
    }
}

#[derive(Clone, Debug, Default)]
struct ResolvedFilterOptions {
    ignore_case: bool,
    max_depth: Option<u64>,
    min_size: Option<u64>,
    max_size: Option<u64>,
    min_age: Option<chrono::Duration>,
    max_age: Option<chrono::Duration>,
    filter_rules: Vec<String>,
    excludes: Vec<String>,
    includes: Vec<String>,
    files_from: Vec<String>,
}

fn resolve_filter_options(opts: &HashMap<String, Value>) -> ResolvedFilterOptions {
    let normalized_opts: HashMap<String, &Value> =
        opts.iter().map(|(k, v)| (k.to_lowercase(), v)).collect();

    let get_opt = |keys: &[&str]| -> Option<&Value> {
        keys.iter()
            .find_map(|k| normalized_opts.get(&k.to_lowercase()).copied())
    };

    let ignore_case = get_opt(&["IgnoreCase", "ignore_case"])
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let max_depth = get_opt(&["MaxDepth", "max_depth"]).and_then(Value::as_u64);

    let min_size = get_opt(&["MinSize", "min_size"]).and_then(|v| {
        v.as_str()
            .and_then(parse_rclone_size)
            .or_else(|| v.as_u64())
    });

    let max_size = get_opt(&["MaxSize", "max_size"]).and_then(|v| {
        v.as_str()
            .and_then(parse_rclone_size)
            .or_else(|| v.as_u64())
    });

    let min_age = get_opt(&["MinAge", "min_age"])
        .and_then(|v| v.as_str())
        .and_then(parse_rclone_duration);

    let max_age = get_opt(&["MaxAge", "max_age"])
        .and_then(|v| v.as_str())
        .and_then(parse_rclone_duration);

    let patterns_for = |keys: &[&str]| -> Vec<String> {
        keys.iter()
            .filter_map(|&key| {
                let val = normalized_opts.get(&key.to_lowercase())?;
                if let Some(arr) = val.as_array() {
                    Some(
                        arr.iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect::<Vec<_>>(),
                    )
                } else {
                    val.as_str().map(|s| vec![s.to_owned()])
                }
            })
            .flatten()
            .collect()
    };

    let patterns_from_files = |keys: &[&str]| -> Vec<String> {
        patterns_for(keys)
            .into_iter()
            .flat_map(|file_path| {
                std::fs::read_to_string(&file_path)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|l| {
                        let trimmed = l.trim();
                        if trimmed.is_empty()
                            || trimmed.starts_with('#')
                            || trimmed.starts_with(';')
                        {
                            None
                        } else {
                            Some(trimmed.to_owned())
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    };

    let mut filter_rules = patterns_for(&["FilterRule", "filter"]);
    filter_rules.extend(patterns_from_files(&["FilterFrom", "filter_from"]));

    let mut excludes = patterns_for(&[
        "ExcludeRule",
        "exclude",
        "ExcludeFile",
        "exclude_if_present",
    ]);
    excludes.extend(patterns_from_files(&["ExcludeFrom", "exclude_from"]));

    let mut includes = patterns_for(&["IncludeRule", "include"]);
    includes.extend(patterns_from_files(&["IncludeFrom", "include_from"]));

    let mut files_from = patterns_for(&["FilesFrom", "files_from"]);
    files_from.extend(patterns_from_files(&["FilesFrom", "files_from"]));

    ResolvedFilterOptions {
        ignore_case,
        max_depth,
        min_size,
        max_size,
        min_age,
        max_age,
        filter_rules,
        excludes,
        includes,
        files_from,
    }
}

fn is_path_filtered(
    path: &std::path::Path,
    src_paths: &[String],
    filter_options: &Option<ResolvedFilterOptions>,
) -> bool {
    let Some(opts) = filter_options else {
        return false;
    };

    // Compute the relative path under the matching source root.
    let rel_path = src_paths
        .iter()
        .find_map(|src| path.strip_prefix(src).ok())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"));

    let Some(rel_path) = rel_path else {
        // Not under any watched source — ignore.
        return true;
    };

    let rel_path = rel_path.trim_matches('/');
    if rel_path.is_empty() {
        return false;
    }

    // MaxDepth
    if let Some(max_depth) = opts.max_depth {
        let depth = rel_path.split('/').filter(|s| !s.is_empty()).count() as u64;
        if depth > max_depth {
            return true;
        }
    }

    // Size and age filters (files only).
    if path.is_file()
        && let Ok(meta) = std::fs::metadata(path)
    {
        let size = meta.len();

        if let Some(min) = opts.min_size
            && size < min
        {
            return true;
        }

        if let Some(max) = opts.max_size
            && size > max
        {
            return true;
        }

        if let Ok(modified) = meta.modified() {
            let age = Utc::now().signed_duration_since(chrono::DateTime::<Utc>::from(modified));

            if let Some(min_age) = opts.min_age
                && age < min_age
            {
                return true;
            }

            if let Some(max_age) = opts.max_age
                && age > max_age
            {
                return true;
            }
        }
    }

    // FilterRule / FilterFrom — ordered include/exclude rules.
    for rule in &opts.filter_rules {
        let rule = rule.trim();
        let (include, pattern) =
            if let Some(p) = rule.strip_prefix("+ ").or_else(|| rule.strip_prefix('+')) {
                (true, p)
            } else if let Some(p) = rule.strip_prefix("- ").or_else(|| rule.strip_prefix('-')) {
                (false, p)
            } else {
                continue;
            };

        if glob_match(pattern, rel_path, opts.ignore_case) {
            return !include;
        }
    }

    // ExcludeRule / ExcludeFrom / ExcludeFile.
    if opts
        .excludes
        .iter()
        .any(|p| glob_match(p, rel_path, opts.ignore_case))
    {
        return true;
    }

    // IncludeRule / IncludeFrom — if any are set, the file must match at least one.
    if !opts.includes.is_empty()
        && !opts
            .includes
            .iter()
            .any(|p| glob_match(p, rel_path, opts.ignore_case))
    {
        return true;
    }

    // FilesFrom / FilesFromRaw — explicit allowlist.
    if !opts.files_from.is_empty()
        && !opts
            .files_from
            .iter()
            .any(|p| glob_match(p, rel_path, opts.ignore_case))
    {
        return true;
    }

    false
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glob_match() {
        assert!(glob_match("*.txt", "foo.txt", false));
        assert!(glob_match("*.txt", "bar/foo.txt", false));
        assert!(glob_match("/foo.txt", "foo.txt", false));
        assert!(!glob_match("/foo.txt", "bar/foo.txt", false));
        assert!(glob_match(
            "src/**/*.rs",
            "src/core/scheduler/watcher.rs",
            false
        ));
        assert!(glob_match("src/**/*.rs", "src/watcher.rs", false));
        assert!(!glob_match("src/**/*.rs", "src/watcher.txt", false));
        assert!(glob_match("*.TXT", "foo.txt", true));
        assert!(!glob_match("*.TXT", "foo.txt", false));
    }

    #[test]
    fn test_parse_rclone_size() {
        assert_eq!(parse_rclone_size("100"), Some(100));
        assert_eq!(parse_rclone_size("10k"), Some(10240));
        assert_eq!(parse_rclone_size("1M"), Some(1048576));
        assert_eq!(parse_rclone_size("1G"), Some(1073741824));
        assert_eq!(parse_rclone_size("1.5M"), Some(1572864));
    }

    #[test]
    fn test_parse_rclone_duration() {
        assert_eq!(
            parse_rclone_duration("30s"),
            Some(chrono::Duration::seconds(30))
        );
        assert_eq!(
            parse_rclone_duration("5m"),
            Some(chrono::Duration::minutes(5))
        );
        assert_eq!(
            parse_rclone_duration("2h"),
            Some(chrono::Duration::hours(2))
        );
        assert_eq!(parse_rclone_duration("3d"), Some(chrono::Duration::days(3)));
        assert_eq!(
            parse_rclone_duration("1w"),
            Some(chrono::Duration::weeks(1))
        );
    }

    #[test]
    fn test_is_path_filtered() {
        let src_paths = vec!["/src".to_string()];

        let mut opts = HashMap::new();
        opts.insert("maxDepth".to_string(), serde_json::json!(2));
        let filter_opts = Some(resolve_filter_options(&opts));

        assert!(!is_path_filtered(
            std::path::Path::new("/src/foo.txt"),
            &src_paths,
            &filter_opts
        ));
        assert!(is_path_filtered(
            std::path::Path::new("/src/foo/bar/baz.txt"),
            &src_paths,
            &filter_opts
        ));

        let mut opts2 = HashMap::new();
        opts2.insert("excludeRule".to_string(), serde_json::json!(["*.log"]));
        let filter_opts2 = Some(resolve_filter_options(&opts2));

        assert!(is_path_filtered(
            std::path::Path::new("/src/error.log"),
            &src_paths,
            &filter_opts2
        ));
        assert!(!is_path_filtered(
            std::path::Path::new("/src/main.rs"),
            &src_paths,
            &filter_opts2
        ));
    }
}
