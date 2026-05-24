use crate::core::settings::AppSettingsManager;
use log::{error, info};
use tauri::{AppHandle, Manager};

use crate::utils::types::origin::Origin;
use crate::{
    rclone::{
        backend::BackendManager,
        commands::{
            job::stop_job,
            mount::{mount_remote_profile, unmount_remote},
            serve::{start_serve_profile, stop_serve},
            sync::{TransferType, start_profile_batch},
        },
    },
    utils::{
        app::notification::{JobStage, NotificationEvent, SystemStage, notify},
        types::{
            jobs::{JobStatus, JobType},
            remotes::ProfileParams,
        },
    },
};

#[cfg(not(feature = "web-server"))]
pub fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        info!("Showing main window");
        window.show().unwrap_or_else(|_| {
            error!("Failed to show main window");
        });
    } else {
        use crate::utils::app::builder::create_app_window;
        info!("Main window not found, building a new one");
        create_app_window(app);
    }
}

fn profile_params(remote_name: &str, profile_name: &str) -> ProfileParams {
    ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
        source: Some(Origin::Dashboard),
        no_cache: None,
    }
}

// ── Transfer jobs ────────────────────────────────────────────────────────────

pub fn handle_start_job_profile(
    app: AppHandle,
    remote_name: &str,
    profile_name: &str,
    transfer_type: TransferType,
) {
    let params = profile_params(remote_name, profile_name);
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();
    let type_label = format!("{transfer_type:?}"); // move öncesi yakala

    tauri::async_runtime::spawn(async move {
        match start_profile_batch(app, transfer_type, params).await {
            Ok(_) => info!("Started {type_label} for {remote} / {profile}"),
            Err(e) => error!("Failed to start {type_label} for {remote} / {profile}: {e}"),
        }
    });
}

pub fn handle_stop_job_profile(
    app: AppHandle,
    remote_name: &str,
    profile_name: &str,
    job_type: JobType,
) {
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let backend_manager = app.state::<BackendManager>();
        let running_job = backend_manager
            .job_cache
            .get_jobs()
            .await
            .into_iter()
            .find(|j| {
                j.remote_name == remote
                    && j.job_type == job_type
                    && j.profile.as_deref() == Some(&profile)
                    && j.status == JobStatus::Running
            });

        match running_job {
            Some(job) => match stop_job(app.clone(), job.jobid, remote.clone()).await {
                Ok(()) => info!(
                    "Stopped {job_type} job {} for {remote} / {profile}",
                    job.jobid
                ),
                Err(e) => error!("Failed to stop {job_type} job {}: {e}", job.jobid),
            },
            None => {
                error!("No active {job_type} job found for {remote} / {profile}");
                let backend_name = backend_manager.get_active_name().await;
                notify(
                    &app,
                    NotificationEvent::Job(JobStage::Failed {
                        backend: backend_name,
                        remote,
                        profile: Some(profile),
                        job_type,
                        error: "no active job".to_string(),
                        origin: Origin::Dashboard,
                        source: None,
                        destination: None,
                    }),
                );
            }
        }
    });
}

// ── Mount ────────────────────────────────────────────────────────────────────

fn get_mount_dest(
    manager: &AppSettingsManager,
    remote: &str,
    profile: Option<&str>,
) -> Option<String> {
    let sub = manager.sub_settings("remotes").ok()?;
    let settings = sub.get_value(remote).ok()?;
    let mount_configs = settings.get("mountConfigs")?.as_object()?;

    let config = match profile {
        Some(p) => mount_configs.get(p)?,
        None => mount_configs.values().next()?,
    };

    crate::rclone::commands::common::parse_common_config(config, &settings).map(|p| p.dest)
}

pub fn handle_mount_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let params = profile_params(remote_name, profile_name);
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        match mount_remote_profile(app, params).await {
            Ok(()) => info!("Mounted {remote} / {profile}"),
            Err(e) => error!("Failed to mount {remote} / {profile}: {e}"),
        }
    });
}

pub fn handle_unmount_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let manager = app.state::<AppSettingsManager>();
        let mount_point = get_mount_dest(&manager, &remote, Some(&profile)).unwrap_or_default();

        match unmount_remote(app, mount_point.clone(), remote.clone()).await {
            Ok(_) => info!("Unmounted {remote} / {profile}"),
            Err(e) => error!("Failed to unmount {remote} / {profile}: {e}"),
        }
    });
}

// ── Serve ────────────────────────────────────────────────────────────────────

pub fn handle_serve_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let params = profile_params(remote_name, profile_name);
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        match start_serve_profile(app, params).await {
            Ok(response) => info!(
                "Started serve for {remote} / {profile} at {}",
                response.addr
            ),
            Err(e) => error!("Failed to start serve for {remote} / {profile}: {e}"),
        }
    });
}

pub fn handle_stop_serve_profile(app: AppHandle, serve_id: &str) {
    let serve_id = serve_id.to_string();

    tauri::async_runtime::spawn(async move {
        let backend_manager = app.state::<BackendManager>();
        let all_serves = backend_manager.remote_cache.get_serves().await;

        let remote_name = all_serves
            .iter()
            .find(|s| s.id == serve_id)
            .and_then(|s| s.params["fs"].as_str())
            .map(|fs| fs.split(':').next().unwrap_or("").to_string())
            .unwrap_or_else(|| "unknown_remote".to_string());

        match stop_serve(app.clone(), serve_id.clone(), remote_name.clone()).await {
            Ok(_) => info!("Stopped serve {serve_id} for {remote_name}"),
            Err(e) => error!("Failed to stop serve {serve_id}: {e}"),
        }
    });
}

// ── Global actions ───────────────────────────────────────────────────────────

pub fn handle_stop_all_jobs(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let backend_manager = app.state::<BackendManager>();
        let active_jobs = backend_manager.job_cache.get_active_jobs().await;

        if active_jobs.is_empty() {
            return;
        }

        let mut stopped = 0usize;
        for job in active_jobs {
            match stop_job(app.clone(), job.jobid, job.remote_name.clone()).await {
                Ok(()) => {
                    stopped += 1;
                    info!("Stopped job {}", job.jobid);
                }
                Err(e) => error!("Failed to stop job {}: {e}", job.jobid),
            }
        }

        if stopped > 0 {
            notify(&app, NotificationEvent::System(SystemStage::AllJobsStopped));
        }
    });
}

#[cfg(not(feature = "web-server"))]
pub fn handle_browse_remote(app: &AppHandle, remote_name: &str) {
    use tauri_plugin_opener::OpenerExt;
    let remote = remote_name.to_string();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let mount_point = get_mount_dest(&app_clone.state::<AppSettingsManager>(), &remote, None)
            .unwrap_or_default();

        match app_clone.opener().open_path(mount_point, None::<&str>) {
            Ok(_) => info!("Opened file manager for {remote}"),
            Err(e) => error!("Failed to open file manager for {remote}: {e}"),
        }
    });
}

#[cfg(not(feature = "web-server"))]
pub fn handle_browse_in_app(app: &AppHandle, remote_name: Option<&str>) {
    info!(
        "Opening in-app browser{}",
        remote_name.map(|n| format!(" for {n}")).unwrap_or_default()
    );

    let label = remote_name
        .map(|name| {
            let slug: String = name
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            format!("nautilus-{slug}")
        })
        .unwrap_or_else(|| "nautilus".to_string());

    let url = match remote_name {
        Some(name) => format!("index.html#/nautilus/{}", urlencoding::encode(name)),
        None => "index.html#/nautilus".to_string(),
    };

    crate::utils::app::builder::new_window(
        app.clone(),
        crate::utils::app::builder::WindowOptions {
            label,
            url,
            title: "RClone Nautilus".to_string(),
            width: Some(1024.0),
            height: Some(768.0),
            remote: remote_name.map(|s| s.to_string()),
            path: None,
        },
    );
}
