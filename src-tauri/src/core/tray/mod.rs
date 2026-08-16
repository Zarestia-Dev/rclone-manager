#![cfg(all(desktop, feature = "tray"))]

pub mod actions;
pub mod core;
pub mod icon;
pub mod menu;
pub mod tray_action;

use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::utils::types::jobs::{JobStatus, JobType};
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::{MountedRemote, OperationType, ServeInstance};
use menu::MenuPlan;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

pub struct TrayMenuState {
    pub last_plan: Mutex<Option<MenuPlan>>,
    pub update_lock: tokio::sync::Mutex<()>,
}

impl Default for TrayMenuState {
    fn default() -> Self {
        Self {
            last_plan: Mutex::new(None),
            update_lock: tokio::sync::Mutex::new(()),
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

pub struct TraySnapshot {
    pub active_jobs: Vec<TrayJobSummary>,
    pub mounted_remotes: Vec<MountedRemote>,
    pub active_serves: Vec<ServeInstance>,
    pub remotes: Vec<TrayRemoteSummary>,
    pub quick_runs: Vec<TrayQuickRunSummary>,
}

impl TraySnapshot {
    pub async fn fetch<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Self> {
        let backend_manager = app.state::<BackendManager>();
        let settings_manager = app.state::<AppSettingsManager>();

        let (active_jobs_raw, mounted_remotes, active_serves, remote_names) = tokio::join!(
            backend_manager.job_cache.get_active_jobs(),
            backend_manager.remote_cache.get_mounted_remotes(),
            backend_manager.remote_cache.get_serves(),
            backend_manager.remote_cache.get_remotes(),
        );

        let active_jobs = active_jobs_raw
            .iter()
            .filter(|j| j.parent_job_id.is_none())
            .map(|j| TrayJobSummary {
                remote_name: j.remote_name.clone(),
            })
            .collect();

        let all_remote_settings = crate::utils::types::remotes::RemoteSettings::load_all(
            settings_manager.inner(),
            &remote_names,
        );

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

                let build_job_profiles = |configs: &Option<
                    std::collections::HashMap<String, crate::utils::types::remotes::ProfileConfig>,
                >,
                                          jtype: &JobType|
                 -> Vec<TrayProfileSummary> {
                    configs
                        .as_ref()
                        .map(|m| {
                            m.keys()
                                .map(|pname| TrayProfileSummary {
                                    is_active: active_jobs_raw.iter().any(|j| {
                                        j.origin != Some(Origin::QuickRun)
                                            && j.quick_run_id.is_none()
                                            && j.remote_name == name
                                            && j.profile.as_ref() == Some(pname)
                                            && j.job_type == *jtype
                                    }),
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
                                is_active: mounted_remotes.iter().any(|mt| {
                                    let remote_clean = target_remote.trim_end_matches(':');
                                    let fs_clean =
                                        mt.fs.split(':').next().unwrap_or("").trim_end_matches(':');
                                    mt.origin != Some(Origin::QuickRun)
                                        && mt.quick_run_id.is_none()
                                        && remote_clean == fs_clean
                                        && mt.profile.as_ref() == Some(pname)
                                }),
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
                                is_active: active_serves.iter().any(|srv| {
                                    let fs =
                                        srv.params.get("fs").and_then(|v| v.as_str()).unwrap_or("");
                                    let remote_clean = target_remote.trim_end_matches(':');
                                    let fs_clean = fs.trim_end_matches(':');
                                    srv.origin != Some(Origin::QuickRun)
                                        && srv.quick_run_id.is_none()
                                        && remote_clean == fs_clean
                                        && srv.profile.as_ref() == Some(pname)
                                }),
                                name: pname.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                TrayRemoteSummary {
                    sync_profiles: build_job_profiles(&s_parsed.sync_configs, &JobType::Sync),
                    copy_profiles: build_job_profiles(&s_parsed.copy_configs, &JobType::Copy),
                    move_profiles: build_job_profiles(&s_parsed.move_configs, &JobType::Move),
                    bisync_profiles: build_job_profiles(&s_parsed.bisync_configs, &JobType::Bisync),
                    check_profiles: build_job_profiles(&s_parsed.check_configs, &JobType::Check),
                    delete_profiles: build_job_profiles(&s_parsed.delete_configs, &JobType::Delete),
                    copyurl_profiles: build_job_profiles(
                        &s_parsed.copyurl_configs,
                        &JobType::CopyUrl,
                    ),
                    archivecreate_profiles: build_job_profiles(
                        &s_parsed.archivecreate_configs,
                        &JobType::ArchiveCreate,
                    ),
                    cryptcheck_profiles: build_job_profiles(
                        &s_parsed.cryptcheck_configs,
                        &JobType::CryptCheck,
                    ),
                    name,
                    show_on_tray,
                    primary_actions,
                    mount_profiles,
                    serve_profiles,
                }
            })
            .collect();

        let raw_quick_runs = crate::core::flow::quick_run::commands::get_all_quick_runs_sync(
            settings_manager.inner(),
        )
        .unwrap_or_default();

        let quick_runs = raw_quick_runs
            .into_iter()
            .map(|qr| {
                let show_on_tray = qr.is_show_on_tray();
                let is_active = match qr.operation_type {
                    OperationType::Mount => mounted_remotes
                        .iter()
                        .any(|mt| mt.quick_run_id.as_deref() == Some(&qr.id)),
                    OperationType::Serve => active_serves
                        .iter()
                        .any(|srv| srv.quick_run_id.as_deref() == Some(&qr.id)),
                    _ => active_jobs_raw.iter().any(|j| {
                        j.status == JobStatus::Running && j.quick_run_id.as_deref() == Some(&qr.id)
                    }),
                };

                TrayQuickRunSummary {
                    id: qr.id,
                    name: qr.name,
                    is_active,
                    show_on_tray,
                }
            })
            .collect();

        Ok(Self {
            active_jobs,
            mounted_remotes,
            active_serves,
            remotes,
            quick_runs,
        })
    }
}
