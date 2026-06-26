#![cfg(all(desktop, feature = "tray"))]

pub mod actions;
pub mod core;
pub mod icon;
pub mod menu;
pub mod tray_action;

use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::utils::types::jobs::JobType;
use crate::utils::types::remotes::{MountedRemote, ServeInstance};
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

pub struct TraySnapshot {
    pub active_jobs: Vec<TrayJobSummary>,
    pub mounted_remotes: Vec<MountedRemote>,
    pub active_serves: Vec<ServeInstance>,
    pub remotes: Vec<TrayRemoteSummary>,
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

        let active_serves_list: Vec<(String, Option<String>)> = active_serves
            .iter()
            .map(|srv| {
                let fs = srv.params["fs"].as_str().unwrap_or("");
                let remote = crate::utils::rclone::util::extract_remote_name_from_fs(fs);
                (remote, srv.profile.clone())
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

                let target_remote = crate::utils::rclone::util::normalize_remote_name(&name);

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
                                        j.remote_name == name
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
                        m.iter()
                            .map(|(pname, cfg)| {
                                let dest = cfg
                                    .rclone
                                    .get("mountPoint")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                TrayProfileSummary {
                                    is_active: mounted_remotes.iter().any(|mt| {
                                        mt.mount_point == dest && mt.profile.as_ref() == Some(pname)
                                    }),
                                    name: pname.clone(),
                                }
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
                                is_active: active_serves_list.iter().any(|(remote, profile)| {
                                    remote == &target_remote && profile.as_ref() == Some(pname)
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

        Ok(Self {
            active_jobs,
            mounted_remotes,
            active_serves,
            remotes,
        })
    }
}
