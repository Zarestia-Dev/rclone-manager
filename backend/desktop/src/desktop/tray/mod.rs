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
use crate::utils::types::jobs::{JobStatus, JobType};
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::{MountedRemote, OperationType, ServeInstance};
use icon::TrayIconKind;
use menu::MenuPlan;
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

pub struct TrayMenuState {
    pub cache: Mutex<TrayVisualCache>,
    pub update_lock: tokio::sync::Mutex<()>,
    pub has_pending: AtomicBool,
    /// Native visibility stays available while vault-protected settings are locked.
    pub visible: AtomicBool,
    /// Latest visibility request, including while asynchronous setup is pending.
    pub requested_visible: AtomicBool,
}

impl Default for TrayMenuState {
    fn default() -> Self {
        Self {
            cache: Mutex::new(TrayVisualCache::default()),
            update_lock: tokio::sync::Mutex::new(()),
            has_pending: AtomicBool::new(false),
            visible: AtomicBool::new(false),
            requested_visible: AtomicBool::new(false),
        }
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
    pub sync_profiles: Vec<TrayProfileSummary>,
    pub copy_profiles: Vec<TrayProfileSummary>,
    pub move_profiles: Vec<TrayProfileSummary>,
    pub bisync_profiles: Vec<TrayProfileSummary>,
    pub check_profiles: Vec<TrayProfileSummary>,
    pub delete_profiles: Vec<TrayProfileSummary>,
    pub copyurl_profiles: Vec<TrayProfileSummary>,
    pub archivecreate_profiles: Vec<TrayProfileSummary>,
    pub cryptcheck_profiles: Vec<TrayProfileSummary>,
    pub mount_profiles: Vec<TrayProfileSummary>,
    pub serve_profiles: Vec<TrayProfileSummary>,
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

        // Index non-quickrun active jobs by (&remote_name, &profile, &job_type) for O(1) profile matching
        let active_profile_jobs: HashSet<(&str, &str, &JobType)> = active_jobs_raw
            .iter()
            .filter(|j| j.origin != Some(Origin::QuickRun) && j.quick_run_id.is_none())
            .filter_map(|j| {
                let profile = j.profile.as_deref()?;
                Some((j.remote_name.as_str(), profile, &j.job_type))
            })
            .collect();

        // Index non-quickrun active mounts by (&clean_fs, &profile)
        let active_profile_mounts: HashSet<(&str, &str)> = mounted_remotes
            .iter()
            .filter(|mt| mt.origin != Some(Origin::QuickRun) && mt.quick_run_id.is_none())
            .filter_map(|mt| {
                let profile = mt.profile.as_deref()?;
                let fs_clean = mt.fs.split(':').next().unwrap_or("").trim_end_matches(':');
                Some((fs_clean, profile))
            })
            .collect();

        // Index non-quickrun active serves by (&clean_fs, &profile)
        let active_profile_serves: HashSet<(&str, &str)> = active_serves
            .iter()
            .filter(|srv| srv.origin != Some(Origin::QuickRun) && srv.quick_run_id.is_none())
            .filter_map(|srv| {
                let profile = srv.profile.as_deref()?;
                let fs = srv.params.get("fs").and_then(|v| v.as_str()).unwrap_or("");
                let fs_clean = fs.trim_end_matches(':');
                Some((fs_clean, profile))
            })
            .collect();

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

                let target_remote = crate::utils::json_helpers::normalize_remote_name(&name);
                let remote_clean = target_remote.trim_end_matches(':');

                let build_job_profiles = |op: OperationType| -> Vec<TrayProfileSummary> {
                    let Some(jtype) = op.as_job_type() else {
                        return Vec::new();
                    };
                    s_parsed
                        .get_configs(op)
                        .map(|m| {
                            m.keys()
                                .map(|pname| TrayProfileSummary {
                                    is_active: active_profile_jobs.contains(&(
                                        name.as_str(),
                                        pname.as_str(),
                                        &jtype,
                                    )),
                                    name: pname.clone(),
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                };

                let mount_profiles = s_parsed
                    .mount_configs
                    .as_ref()
                    .map(|m| {
                        m.keys()
                            .map(|pname| TrayProfileSummary {
                                is_active: active_profile_mounts
                                    .contains(&(remote_clean, pname.as_str())),
                                name: pname.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                let serve_profiles = s_parsed
                    .serve_configs
                    .as_ref()
                    .map(|m| {
                        m.keys()
                            .map(|pname| TrayProfileSummary {
                                is_active: active_profile_serves
                                    .contains(&(remote_clean, pname.as_str())),
                                name: pname.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                TrayRemoteSummary {
                    sync_profiles: build_job_profiles(OperationType::Sync),
                    copy_profiles: build_job_profiles(OperationType::Copy),
                    move_profiles: build_job_profiles(OperationType::Move),
                    bisync_profiles: build_job_profiles(OperationType::Bisync),
                    check_profiles: build_job_profiles(OperationType::Check),
                    delete_profiles: build_job_profiles(OperationType::Delete),
                    copyurl_profiles: build_job_profiles(OperationType::Copyurl),
                    archivecreate_profiles: build_job_profiles(OperationType::Archivecreate),
                    cryptcheck_profiles: build_job_profiles(OperationType::Cryptcheck),
                    name: name.to_owned(),
                    show_on_tray,
                    primary_actions,
                    mount_profiles,
                    serve_profiles,
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
