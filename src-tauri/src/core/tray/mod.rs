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
use std::collections::HashSet;
use tauri::{AppHandle, Manager, Runtime};

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

        let remotes_settings = settings_manager.inner().sub_settings("remotes").ok();

        // Build O(1) lookup sets.
        // Key: (remote_name, profile, job_type)
        let active_job_set: HashSet<(String, Option<String>, JobType)> = active_jobs_raw
            .iter()
            .map(|j| (j.remote_name.clone(), j.profile.clone(), j.job_type.clone()))
            .collect();

        // Mount detection: keyed by (mount_point, profile) so profile-based
        // submenu items correctly reflect active state.
        let mounted_set: HashSet<(String, Option<String>)> = mounted_remotes
            .iter()
            .map(|m| (m.mount_point.clone(), m.profile.clone()))
            .collect();

        // Serve detection: keyed by (normalised_remote, profile).
        let active_serves_set: HashSet<(String, Option<String>)> = active_serves
            .iter()
            .map(|srv| {
                let fs = srv.params["fs"].as_str().unwrap_or("");
                let remote = crate::utils::rclone::util::extract_remote_name_from_fs(fs);
                (remote, srv.profile.clone())
            })
            .collect();

        let active_jobs = active_jobs_raw
            .iter()
            .map(|j| TrayJobSummary {
                remote_name: j.remote_name.clone(),
            })
            .collect();

        let remotes = remote_names
            .into_iter()
            .map(|name| {
                let s = remotes_settings
                    .as_ref()
                    .and_then(|rs| rs.get_value(&name).ok());

                let show_on_tray = s
                    .as_ref()
                    .and_then(|v| v.get("showOnTray"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let primary_actions = s
                    .as_ref()
                    .and_then(|v| v.get("primaryActions"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_else(|| vec!["mount".into(), "sync".into(), "bisync".into()]);

                let target_remote = crate::utils::rclone::util::normalize_remote_name(&name);

                // Build job-type profiles from a config key and a specific JobType.
                let build_job_profiles = |key: &str, jtype: &JobType| -> Vec<TrayProfileSummary> {
                    s.as_ref()
                        .and_then(|v| v.get(key))
                        .and_then(|v| v.as_object())
                        .map(|m| {
                            m.keys()
                                .map(|pname| TrayProfileSummary {
                                    is_active: active_job_set.contains(&(
                                        name.clone(),
                                        Some(pname.clone()),
                                        jtype.clone(),
                                    )),
                                    name: pname.clone(),
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                };

                // Mount profiles: active when their specific dest+profile is mounted.
                let mount_profiles = s
                    .as_ref()
                    .and_then(|v| v.get("mountConfigs"))
                    .and_then(|v| v.as_object())
                    .map(|m| {
                        m.iter()
                            .map(|(pname, cfg)| {
                                let dest = cfg.get("dest").and_then(|v| v.as_str()).unwrap_or("");
                                TrayProfileSummary {
                                    is_active: mounted_set
                                        .contains(&(dest.to_string(), Some(pname.clone()))),
                                    name: pname.clone(),
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                let serve_profiles = s
                    .as_ref()
                    .and_then(|v| v.get("serveConfigs"))
                    .and_then(|v| v.as_object())
                    .map(|m| {
                        m.keys()
                            .map(|pname| TrayProfileSummary {
                                is_active: active_serves_set
                                    .contains(&(target_remote.clone(), Some(pname.clone()))),
                                name: pname.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                TrayRemoteSummary {
                    sync_profiles: build_job_profiles("syncConfigs", &JobType::Sync),
                    copy_profiles: build_job_profiles("copyConfigs", &JobType::Copy),
                    move_profiles: build_job_profiles("moveConfigs", &JobType::Move),
                    bisync_profiles: build_job_profiles("bisyncConfigs", &JobType::Bisync),
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
