use crate::context::BackendContext;
pub mod actions;
pub mod core;
pub(crate) mod events;
pub mod icon;
pub mod menu;
pub(crate) mod setup;
pub mod tray_action;

use crate::rclone::backend::BackendManager;
use crate::services::settings::AppSettingsManager;
use crate::utils::json_helpers::{extract_remote_name_from_fs, normalize_remote_name};
use crate::utils::types::jobs::{JobInfo, JobStatus, JobType};
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::{MountedRemote, OperationType, ServeInstance};
use icon::TrayIconKind;
use menu::MenuPlan;
use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use tauri::{AppHandle, Runtime};

#[derive(Default, Clone, Debug, PartialEq)]
pub struct TrayVisualCache {
    pub plan: Option<MenuPlan>,
    pub tooltip: Option<String>,
    pub icon: Option<TrayIconKind>,
}

impl TrayVisualCache {
    /// Compare with the last successfully applied native visuals without committing changes.
    pub fn diff(
        &self,
        new_plan: &MenuPlan,
        new_tooltip: &str,
        new_icon: TrayIconKind,
    ) -> (bool, bool, bool) {
        (
            self.plan.as_ref() != Some(new_plan),
            self.tooltip.as_deref() != Some(new_tooltip),
            self.icon != Some(new_icon),
        )
    }
}

#[derive(Default)]
pub struct TrayMenuState {
    visuals: Mutex<TrayVisualCache>,
    pub update_lock: tokio::sync::Mutex<()>,
    pub has_pending: AtomicBool,
    /// Native visibility stays available while vault-protected settings are locked.
    pub visible: AtomicBool,
    /// Latest visibility request, including while asynchronous setup is pending.
    pub requested_visible: AtomicBool,
}

impl TrayMenuState {
    /// What the native tray currently shows. It is plain data, so a lock poisoned by a
    /// panic elsewhere is still safe to use and must not take the tray down with it.
    pub fn visuals(&self) -> std::sync::MutexGuard<'_, TrayVisualCache> {
        self.visuals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Clone)]
pub struct TrayJobSummary {
    pub remote_name: String,
}

#[derive(Clone)]
pub struct TrayProfileSummary {
    pub name: String,
    pub is_active: bool,
}

#[derive(Clone)]
pub struct TrayRemoteSummary {
    pub name: String,
    pub show_on_tray: bool,
    pub primary_actions: Vec<String>,
    /// Profiles of every operation the remote can run, in `OperationType::ALL` order.
    pub profiles: Vec<(OperationType, Vec<TrayProfileSummary>)>,
}

impl TrayRemoteSummary {
    pub fn profiles_for(&self, op: OperationType) -> &[TrayProfileSummary] {
        self.profiles
            .iter()
            .find(|(candidate, _)| *candidate == op)
            .map_or(&[], |(_, profiles)| profiles.as_slice())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrayQuickRunSummary {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub show_on_tray: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrayWorkflowSummary {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub show_on_tray: bool,
}

/// Which configured profiles are running right now. Runs started by quick runs are left
/// out: they belong to the quick run, not to the profile they were copied from.
struct ActiveProfiles<'a> {
    jobs: HashSet<(&'a str, &'a str, &'a JobType)>,
    // Mounts and serves are matched by remote name, so a serve of `remote:sub/path`
    // is found the same way as a mount of `remote:`.
    mounts: HashSet<(Cow<'a, str>, &'a str)>,
    serves: HashSet<(Cow<'a, str>, &'a str)>,
}

impl<'a> ActiveProfiles<'a> {
    fn new(jobs: &'a [JobInfo], mounts: &'a [MountedRemote], serves: &'a [ServeInstance]) -> Self {
        Self {
            jobs: jobs
                .iter()
                .filter(|j| j.origin != Some(Origin::QuickRun) && j.quick_run_id.is_none())
                .filter_map(|j| Some((j.remote_name.as_str(), j.profile.as_deref()?, &j.job_type)))
                .collect(),
            mounts: mounts
                .iter()
                .filter(|m| m.origin != Some(Origin::QuickRun) && m.quick_run_id.is_none())
                .filter_map(|m| Some((extract_remote_name_from_fs(&m.fs), m.profile.as_deref()?)))
                .collect(),
            serves: serves
                .iter()
                .filter(|s| s.origin != Some(Origin::QuickRun) && s.quick_run_id.is_none())
                .filter_map(|s| {
                    let fs = s.params.get("fs").and_then(|v| v.as_str())?;
                    Some((extract_remote_name_from_fs(fs), s.profile.as_deref()?))
                })
                .collect(),
        }
    }

    fn contains(&self, remote: &str, op: OperationType, profile: &str) -> bool {
        match op {
            OperationType::Mount => self
                .mounts
                .contains(&(normalize_remote_name(remote), profile)),
            OperationType::Serve => self
                .serves
                .contains(&(normalize_remote_name(remote), profile)),
            op => op
                .as_job_type()
                .is_some_and(|job_type| self.jobs.contains(&(remote, profile, &job_type))),
        }
    }
}

pub struct TraySnapshot {
    pub active_jobs: Vec<TrayJobSummary>,
    pub mounted_remotes: Vec<MountedRemote>,
    pub active_serves: Vec<ServeInstance>,
    pub remotes: Vec<TrayRemoteSummary>,
    pub quick_runs: Vec<TrayQuickRunSummary>,
    pub workflows: Vec<TrayWorkflowSummary>,
}

impl TraySnapshot {
    pub async fn fetch<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Self> {
        let backend_manager = app.backend_state::<BackendManager>();
        let settings_manager = app.backend_state::<AppSettingsManager>();

        let backend = backend_manager.get_active().await;
        let jobs = backend_manager.job_cache_for(&backend.name);
        let remotes = backend_manager.remote_cache_for(&backend.name);
        let (active_jobs_raw, mounted_remotes, active_serves, remote_names) = tokio::join!(
            jobs.get_active_jobs(),
            remotes.get_mounted_remotes(),
            remotes.get_serves(),
            remotes.get_remotes(),
        );

        let active_jobs: Vec<TrayJobSummary> = active_jobs_raw
            .iter()
            .filter(|j| j.parent_job_id.is_none())
            .map(|j| TrayJobSummary {
                remote_name: j.remote_name.clone(),
            })
            .collect();

        let active_profiles =
            ActiveProfiles::new(&active_jobs_raw, &mounted_remotes, &active_serves);

        // Index active quick run IDs
        let active_qr_mounts: HashSet<&str> = mounted_remotes
            .iter()
            .filter_map(|mt| mt.quick_run_id.as_deref())
            .collect();

        let active_qr_serves: HashSet<&str> = active_serves
            .iter()
            .filter_map(|srv| srv.quick_run_id.as_deref())
            .collect();

        let active_qr_jobs: HashSet<&str> = active_jobs_raw
            .iter()
            .filter(|j| j.status == JobStatus::Running)
            .filter_map(|j| j.quick_run_id.as_deref())
            .collect();

        let all_remote_settings =
            crate::utils::types::remotes::RemoteSettings::load_all(settings_manager.inner());

        let remotes = remote_names
            .into_iter()
            .map(|name| {
                let s_parsed = all_remote_settings.get(&name).cloned().unwrap_or_default();

                let show_on_tray = s_parsed.show_on_tray;

                let primary_actions = s_parsed
                    .primary_actions
                    .clone()
                    .unwrap_or_else(|| vec!["mount".into(), "sync".into(), "bisync".into()]);

                let profiles = OperationType::ALL
                    .iter()
                    .map(|&op| {
                        let summaries = s_parsed
                            .get_configs(op)
                            .map(|configs| {
                                configs
                                    .keys()
                                    .map(|profile| TrayProfileSummary {
                                        is_active: active_profiles.contains(&name, op, profile),
                                        name: profile.clone(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        (op, summaries)
                    })
                    .collect();

                TrayRemoteSummary {
                    name: name.clone(),
                    show_on_tray,
                    primary_actions,
                    profiles,
                }
            })
            .collect();

        let raw_quick_runs = crate::services::flow::quick_run::commands::get_all_quick_runs_sync(
            settings_manager.inner(),
        )
        .unwrap_or_default();

        let quick_runs = raw_quick_runs
            .into_iter()
            .map(|qr| {
                let show_on_tray = qr.is_show_on_tray();
                let is_active = match qr.operation_type {
                    OperationType::Mount => active_qr_mounts.contains(qr.id.as_str()),
                    OperationType::Serve => active_qr_serves.contains(qr.id.as_str()),
                    _ => active_qr_jobs.contains(qr.id.as_str()),
                };

                TrayQuickRunSummary {
                    id: qr.id,
                    name: qr.name,
                    is_active,
                    show_on_tray,
                }
            })
            .collect();

        let raw_workflows = crate::services::flow::workflow::commands::get_all_workflows_sync(
            settings_manager.inner(),
        )
        .unwrap_or_default();

        let active_wf_ids =
            crate::services::flow::workflow::engine::get_active_workflow_ids(&backend.name);

        let workflows = raw_workflows
            .into_iter()
            .map(|wf| {
                let is_active = active_wf_ids.contains(&wf.id);
                TrayWorkflowSummary {
                    id: wf.id,
                    name: wf.name,
                    is_active,
                    show_on_tray: wf.show_on_tray,
                }
            })
            .collect();

        Ok(Self {
            active_jobs,
            mounted_remotes,
            active_serves,
            remotes,
            quick_runs,
            workflows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cached_visuals() -> TrayVisualCache {
        TrayVisualCache {
            plan: Some(MenuPlan { items: vec![] }),
            tooltip: Some("Tooltip".into()),
            icon: Some(TrayIconKind::ColorNormal),
        }
    }

    fn job(remote: &str, profile: &str, job_type: JobType) -> JobInfo {
        serde_json::from_value(serde_json::json!({
            "jobid": 1,
            "job_type": job_type,
            "remote_name": remote,
            "source": [],
            "destination": "",
            "start_time": "2026-01-01T00:00:00Z",
            "status": "Running",
            "stats": null,
            "group": "job/1",
            "profile": profile,
        }))
        .unwrap()
    }

    fn serve(fs: &str, profile: &str) -> ServeInstance {
        let mut serve = ServeInstance::new("id", "127.0.0.1:1", serde_json::json!({ "fs": fs }));
        serve.profile = Some(profile.into());
        serve
    }

    fn mount(fs: &str, profile: &str) -> MountedRemote {
        let mut mount = MountedRemote::new(fs, "/mnt");
        mount.profile = Some(profile.into());
        mount
    }

    #[test]
    fn running_profiles_are_matched_by_remote_operation_and_name() {
        let jobs = [job("gdrive", "Default", JobType::Sync)];
        let mounts = [mount("gdrive:", "Default")];
        let serves = [serve("gdrive:photos/2024", "Default")];
        let active = ActiveProfiles::new(&jobs, &mounts, &serves);

        assert!(active.contains("gdrive", OperationType::Sync, "Default"));
        assert!(active.contains("gdrive", OperationType::Mount, "Default"));
        // A serve of a sub-path belongs to its remote like any other.
        assert!(active.contains("gdrive", OperationType::Serve, "Default"));
        assert!(active.contains("gdrive:", OperationType::Serve, "Default"));

        // Profile names repeat across remotes and operations.
        assert!(!active.contains("other", OperationType::Sync, "Default"));
        assert!(!active.contains("other", OperationType::Serve, "Default"));
        assert!(!active.contains("gdrive2", OperationType::Mount, "Default"));
        assert!(!active.contains("gdrive", OperationType::Copy, "Default"));
        assert!(!active.contains("gdrive", OperationType::Sync, "Other"));
    }

    #[test]
    fn quick_run_executions_do_not_mark_profiles_active() {
        let mut quick_job = job("gdrive", "Default", JobType::Sync);
        quick_job.quick_run_id = Some("qr-1".into());
        let mut quick_mount = mount("gdrive:", "Default");
        quick_mount.origin = Some(Origin::QuickRun);
        let jobs = [quick_job];
        let mounts = [quick_mount];
        let active = ActiveProfiles::new(&jobs, &mounts, &[]);
        assert!(!active.contains("gdrive", OperationType::Sync, "Default"));
        assert!(!active.contains("gdrive", OperationType::Mount, "Default"));
    }

    #[test]
    fn initial_visuals_require_all_native_updates() {
        let cache = TrayVisualCache::default();
        assert_eq!(
            cache.diff(
                &MenuPlan { items: vec![] },
                "Tooltip",
                TrayIconKind::ColorNormal
            ),
            (true, true, true)
        );
        assert_eq!(cache, TrayVisualCache::default());
    }

    #[test]
    fn unchanged_visuals_do_not_require_native_updates() {
        let cache = cached_visuals();
        assert_eq!(
            cache.diff(
                &MenuPlan { items: vec![] },
                "Tooltip",
                TrayIconKind::ColorNormal
            ),
            (false, false, false)
        );
    }

    #[test]
    fn failed_or_unapplied_plan_changes_remain_pending() {
        let cache = cached_visuals();
        let plan = MenuPlan {
            items: vec![menu::MenuItemKind::Separator],
        };
        for _ in 0..2 {
            assert_eq!(
                cache.diff(&plan, "Tooltip", TrayIconKind::ColorNormal),
                (true, false, false)
            );
        }
        assert_eq!(cache, cached_visuals());
    }

    #[test]
    fn tooltip_and_icon_changes_are_independent() {
        let cache = cached_visuals();
        let plan = MenuPlan { items: vec![] };
        assert_eq!(
            cache.diff(&plan, "Changed", TrayIconKind::ColorNormal),
            (false, true, false)
        );
        assert_eq!(
            cache.diff(&plan, "Tooltip", TrayIconKind::ColorActive),
            (false, false, true)
        );
    }
}
