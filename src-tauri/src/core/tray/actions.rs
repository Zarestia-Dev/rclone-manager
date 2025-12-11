use log::{debug, error, info, warn};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::{
    rclone::{
        commands::{
            job::stop_job,
            mount::{MountParams, mount_remote, unmount_remote},
            serve::{ServeParams, start_serve, stop_all_serves, stop_serve},
            sync::{
                BisyncParams, CopyParams, MoveParams, SyncParams, start_bisync, start_copy,
                start_move, start_sync,
            },
        },
        state::scheduled_tasks::ScheduledTasksCache,
    },
    utils::{
        app::{builder::create_app_window, notification::send_notification},
        io::file_helper::get_folder_location,
        types::all_types::{JobCache, JobStatus, RcloneState, RemoteCache},
    },
};

fn notify(app: &AppHandle, title: &str, body: &str) {
    send_notification(app, title, body);
}

async fn prompt_mount_point(app: &AppHandle, remote_name: &str) -> Option<String> {
    let response = app
        .dialog()
        .message(format!(
            "No mount point specified for '{remote_name}'. Would you like to select one now?"
        ))
        .title("Mount Point Required")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Yes, Select".to_owned(),
            "Cancel".to_owned(),
        ))
        .kind(MessageDialogKind::Warning)
        .blocking_show();

    if !response {
        info!("❌ User cancelled mount point selection for {remote_name}");
        return None;
    }

    match get_folder_location(app.clone(), false).await {
        Ok(Some(path)) if !path.is_empty() => {
            info!("📁 Selected mount point for {remote_name}: {path}");
            Some(path)
        }
        Ok(Some(_)) => {
            info!("⚠️ User selected an empty folder path for {remote_name}");
            None
        }
        Ok(none) => {
            info!("❌ User didn't select a folder for {remote_name}");
            none
        }
        Err(err) => {
            error!("🚨 Error selecting folder for {remote_name}: {err}");
            None
        }
    }
}

pub fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        debug!("🪟 Showing main window");
        window.show().unwrap_or_else(|_| {
            error!("🚨 Failed to show main window");
        });
    } else {
        warn!("⚠️ Main window not found. Building...");
        create_app_window(app);
    }
}

// ========== PROFILE-SPECIFIC HANDLERS ==========

pub fn handle_mount_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    let profile_name_clone = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name_clone} not found in settings");
                return;
            }
        };

        // Find the specific mount profile
        let mount_configs = match settings.get("mountConfigs").and_then(|v| v.as_array()) {
            Some(configs) => configs,
            None => {
                error!("❌ No mountConfigs found for {}", remote_name_clone);
                return;
            }
        };

        let mount_config = match mount_configs.iter().find(|c| {
            c.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n == profile_name_clone)
                .unwrap_or(false)
        }) {
            Some(config) => config.clone(),
            None => {
                error!("❌ Mount profile '{}' not found", profile_name_clone);
                return;
            }
        };

        // Create temporary settings with this profile as the active mountConfig
        let mut temp_settings = settings.clone();
        temp_settings["mountConfig"] = mount_config;

        let mut params = match MountParams::from_settings(remote_name_clone.clone(), &temp_settings)
        {
            Some(p) => p,
            None => {
                error!(
                    "🚨 Mount configuration incomplete for profile '{}'",
                    profile_name_clone
                );
                notify(
                    &app_clone,
                    "Mount Failed",
                    &format!(
                        "Mount configuration incomplete for profile '{}'",
                        profile_name_clone
                    ),
                );
                return;
            }
        };

        let mount_point = if !params.mount_point.is_empty() {
            params.mount_point.clone()
        } else {
            match prompt_mount_point(&app_clone, &remote_name_clone).await {
                Some(path) => path,
                _ => {
                    info!("❌ Mounting cancelled - no mount point selected");
                    return;
                }
            }
        };
        params.mount_point = mount_point.clone();

        let job_cache_state = app_clone.state::<JobCache>();

        match mount_remote(
            app_clone.clone(),
            job_cache_state,
            cache.clone(),
            params.clone(),
        )
        .await
        {
            Ok(_) => {
                info!(
                    "✅ Successfully mounted {} profile '{}'",
                    remote_name_clone, profile_name_clone
                );
                notify(
                    &app_clone,
                    "Mount Successful",
                    &format!(
                        "Successfully mounted {} profile '{}' at {}",
                        remote_name_clone, profile_name_clone, mount_point
                    ),
                );
            }
            Err(e) => {
                error!(
                    "🚨 Failed to mount {} profile '{}': {}",
                    remote_name_clone, profile_name_clone, e
                );
                notify(
                    &app_clone,
                    "Mount Failed",
                    &format!(
                        "Failed to mount {} profile '{}': {}",
                        remote_name_clone, profile_name_clone, e
                    ),
                );
            }
        }
    });
}

pub fn handle_unmount_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = settings_val.get(&remote).cloned().unwrap_or_else(|| {
            error!("🚨 Remote {remote} not found in cached settings");
            serde_json::Value::Null
        });

        // Find the specific mount profile to get its mount point
        let mount_configs = match settings.get("mountConfigs").and_then(|v| v.as_array()) {
            Some(configs) => configs,
            None => {
                error!("❌ No mountConfigs found for {}", remote);
                return;
            }
        };

        let mount_point = match mount_configs.iter().find(|c| {
            c.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n == profile)
                .unwrap_or(false)
        }) {
            Some(config) => config
                .get("dest")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            None => {
                error!("❌ Mount profile '{}' not found", profile);
                return;
            }
        };

        let state = app_clone.state();
        match unmount_remote(
            app_clone.clone(),
            mount_point.clone(),
            remote.clone(),
            state,
        )
        .await
        {
            Ok(_) => {
                info!("🛑 Unmounted {} profile '{}'", remote, profile);
                notify(
                    &app_clone,
                    "Unmount Successful",
                    &format!("Successfully unmounted {} profile '{}'", remote, profile),
                );
            }
            Err(err) => {
                error!(
                    "🚨 Failed to unmount {} profile '{}': {}",
                    remote, profile, err
                );
                notify(
                    &app_clone,
                    "Unmount Failed",
                    &format!(
                        "Failed to unmount {} profile '{}': {}",
                        remote, profile, err
                    ),
                );
            }
        }
    });
}

pub fn handle_sync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    let profile_name_clone = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {} not found in settings", remote_name_clone);
                return;
            }
        };

        // Find the specific profile
        let configs = match settings.get("syncConfigs").and_then(|v| v.as_array()) {
            Some(configs) => configs,
            None => {
                error!("❌ No syncConfigs found for {}", remote_name_clone);
                return;
            }
        };

        let config = match configs.iter().find(|c| {
            c.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n == profile_name_clone)
                .unwrap_or(false)
        }) {
            Some(config) => config.clone(),
            None => {
                error!("❌ Sync profile '{}' not found", profile_name_clone);
                return;
            }
        };

        // Create temporary settings with this profile as the active config
        let mut temp_settings = settings.clone();
        temp_settings["syncConfig"] = config;

        let params = match SyncParams::from_settings(remote_name_clone.clone(), &temp_settings) {
            Some(p) => p,
            None => {
                error!(
                    "🚨 Sync configuration incomplete for profile '{}'",
                    profile_name_clone
                );
                notify(
                    &app_clone,
                    "Sync Failed",
                    &format!(
                        "Sync configuration incomplete for profile '{}'",
                        profile_name_clone
                    ),
                );
                return;
            }
        };

        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_sync(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!(
                    "✅ Started Sync for {} profile '{}'",
                    remote_name_clone, profile_name_clone
                );
                notify(
                    &app_clone,
                    "Sync Started",
                    &format!(
                        "Started Sync for {} profile '{}'",
                        remote_name_clone, profile_name_clone
                    ),
                );
            }
            Err(e) => {
                error!(
                    "🚨 Failed to start Sync for {} profile '{}': {}",
                    remote_name_clone, profile_name_clone, e
                );
                notify(
                    &app_clone,
                    "Sync Failed",
                    &format!(
                        "Failed to start Sync for {} profile '{}': {}",
                        remote_name_clone, profile_name_clone, e
                    ),
                );
            }
        }
    });
}

pub fn handle_copy_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    let profile_name_clone = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {} not found in settings", remote_name_clone);
                return;
            }
        };

        let configs = match settings.get("copyConfigs").and_then(|v| v.as_array()) {
            Some(configs) => configs,
            None => {
                error!("❌ No copyConfigs found for {}", remote_name_clone);
                return;
            }
        };

        let config = match configs.iter().find(|c| {
            c.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n == profile_name_clone)
                .unwrap_or(false)
        }) {
            Some(config) => config.clone(),
            None => {
                error!("❌ Copy profile '{}' not found", profile_name_clone);
                return;
            }
        };

        let mut temp_settings = settings.clone();
        temp_settings["copyConfig"] = config;

        let params = match CopyParams::from_settings(remote_name_clone.clone(), &temp_settings) {
            Some(p) => p,
            None => {
                error!(
                    "🚨 Copy configuration incomplete for profile '{}'",
                    profile_name_clone
                );
                notify(
                    &app_clone,
                    "Copy Failed",
                    &format!(
                        "Copy configuration incomplete for profile '{}'",
                        profile_name_clone
                    ),
                );
                return;
            }
        };

        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_copy(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!(
                    "✅ Started Copy for {} profile '{}'",
                    remote_name_clone, profile_name_clone
                );
                notify(
                    &app_clone,
                    "Copy Started",
                    &format!(
                        "Started Copy for {} profile '{}'",
                        remote_name_clone, profile_name_clone
                    ),
                );
            }
            Err(e) => {
                error!(
                    "🚨 Failed to start Copy for {} profile '{}': {}",
                    remote_name_clone, profile_name_clone, e
                );
                notify(
                    &app_clone,
                    "Copy Failed",
                    &format!(
                        "Failed to start Copy for {} profile '{}': {}",
                        remote_name_clone, profile_name_clone, e
                    ),
                );
            }
        }
    });
}

pub fn handle_move_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    let profile_name_clone = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {} not found in settings", remote_name_clone);
                return;
            }
        };

        let configs = match settings.get("moveConfigs").and_then(|v| v.as_array()) {
            Some(configs) => configs,
            None => {
                error!("❌ No moveConfigs found for {}", remote_name_clone);
                return;
            }
        };

        let config = match configs.iter().find(|c| {
            c.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n == profile_name_clone)
                .unwrap_or(false)
        }) {
            Some(config) => config.clone(),
            None => {
                error!("❌ Move profile '{}' not found", profile_name_clone);
                return;
            }
        };

        let mut temp_settings = settings.clone();
        temp_settings["moveConfig"] = config;

        let params = match MoveParams::from_settings(remote_name_clone.clone(), &temp_settings) {
            Some(p) => p,
            None => {
                error!(
                    "🚨 Move configuration incomplete for profile '{}'",
                    profile_name_clone
                );
                notify(
                    &app_clone,
                    "Move Failed",
                    &format!(
                        "Move configuration incomplete for profile '{}'",
                        profile_name_clone
                    ),
                );
                return;
            }
        };

        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_move(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!(
                    "✅ Started Move for {} profile '{}'",
                    remote_name_clone, profile_name_clone
                );
                notify(
                    &app_clone,
                    "Move Started",
                    &format!(
                        "Started Move for {} profile '{}'",
                        remote_name_clone, profile_name_clone
                    ),
                );
            }
            Err(e) => {
                error!(
                    "🚨 Failed to start Move for {} profile '{}': {}",
                    remote_name_clone, profile_name_clone, e
                );
                notify(
                    &app_clone,
                    "Move Failed",
                    &format!(
                        "Failed to start Move for {} profile '{}': {}",
                        remote_name_clone, profile_name_clone, e
                    ),
                );
            }
        }
    });
}

pub fn handle_bisync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    let profile_name_clone = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {} not found in settings", remote_name_clone);
                return;
            }
        };

        let configs = match settings.get("bisyncConfigs").and_then(|v| v.as_array()) {
            Some(configs) => configs,
            None => {
                error!("❌ No bisyncConfigs found for {}", remote_name_clone);
                return;
            }
        };

        let config = match configs.iter().find(|c| {
            c.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n == profile_name_clone)
                .unwrap_or(false)
        }) {
            Some(config) => config.clone(),
            None => {
                error!("❌ Bisync profile '{}' not found", profile_name_clone);
                return;
            }
        };

        let mut temp_settings = settings.clone();
        temp_settings["bisyncConfig"] = config;

        let params = match BisyncParams::from_settings(remote_name_clone.clone(), &temp_settings) {
            Some(p) => p,
            None => {
                error!(
                    "🚨 BiSync configuration incomplete for profile '{}'",
                    profile_name_clone
                );
                notify(
                    &app_clone,
                    "BiSync Failed",
                    &format!(
                        "BiSync configuration incomplete for profile '{}'",
                        profile_name_clone
                    ),
                );
                return;
            }
        };

        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_bisync(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!(
                    "✅ Started BiSync for {} profile '{}'",
                    remote_name_clone, profile_name_clone
                );
                notify(
                    &app_clone,
                    "BiSync Started",
                    &format!(
                        "Started BiSync for {} profile '{}'",
                        remote_name_clone, profile_name_clone
                    ),
                );
            }
            Err(e) => {
                error!(
                    "🚨 Failed to start BiSync for {} profile '{}': {}",
                    remote_name_clone, profile_name_clone, e
                );
                notify(
                    &app_clone,
                    "BiSync Failed",
                    &format!(
                        "Failed to start BiSync for {} profile '{}': {}",
                        remote_name_clone, profile_name_clone, e
                    ),
                );
            }
        }
    });
}

/// Generic handler for stopping job profiles
async fn handle_stop_job_profile(
    app: AppHandle,
    remote_name: String,
    profile_name: String,
    job_type: &str,
    action_name: &str,
) {
    let job_cache_state = app.state::<JobCache>();

    if let Some(job) = job_cache_state.get_jobs().await.iter().find(|j| {
        j.remote_name == remote_name
            && j.job_type == job_type
            && j.profile.as_ref() == Some(&profile_name)
            && j.status == JobStatus::Running
    }) {
        let scheduled_cache = app.state::<ScheduledTasksCache>();
        match stop_job(
            app.clone(),
            job_cache_state,
            scheduled_cache,
            job.jobid,
            remote_name.clone(),
            app.state(),
        )
        .await
        {
            Ok(_) => {
                info!(
                    "🛑 Stopped {} job {} for {} profile '{}'",
                    job_type, job.jobid, remote_name, profile_name
                );
                notify(
                    &app,
                    &format!("{} Stopped", action_name),
                    &format!(
                        "Stopped {} for {} profile '{}'",
                        job_type, remote_name, profile_name
                    ),
                );
            }
            Err(e) => {
                error!("🚨 Failed to stop {} job {}: {}", job_type, job.jobid, e);
                notify(
                    &app,
                    &format!("Stop {} Failed", action_name),
                    &format!(
                        "Failed to stop {} for {} profile '{}': {}",
                        job_type, remote_name, profile_name, e
                    ),
                );
            }
        }
    } else {
        error!(
            "🚨 No active {} job found for {} profile '{}'",
            job_type, remote_name, profile_name
        );
        notify(
            &app,
            &format!("Stop {} Failed", action_name),
            &format!(
                "No active {} job found for {} profile '{}'",
                job_type, remote_name, profile_name
            ),
        );
    }
}

pub fn handle_stop_sync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "sync",
        "Sync",
    ));
}

pub fn handle_stop_copy_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "copy",
        "Copy",
    ));
}

pub fn handle_stop_move_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "move",
        "Move",
    ));
}

pub fn handle_stop_bisync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "bisync",
        "BiSync",
    ));
}

pub fn handle_serve_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    let profile_name_clone = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let job_cache_state = app_clone.state::<JobCache>();
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {} not found in settings", remote_name_clone);
                return;
            }
        };

        // Find the specific serve profile
        let serve_configs = match settings.get("serveConfigs").and_then(|v| v.as_array()) {
            Some(configs) => configs,
            None => {
                error!("❌ No serveConfigs found for {}", remote_name_clone);
                return;
            }
        };

        let serve_config = match serve_configs.iter().find(|c| {
            c.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n == profile_name_clone)
                .unwrap_or(false)
        }) {
            Some(config) => config.clone(),
            None => {
                error!("❌ Serve profile '{}' not found", profile_name_clone);
                return;
            }
        };

        // Create temporary settings with this profile as the active serveConfig
        let mut temp_settings = settings.clone();
        temp_settings["serveConfig"] = serve_config;

        let params = match ServeParams::from_settings(remote_name_clone.clone(), &temp_settings) {
            Some(p) => p,
            None => {
                error!(
                    "🚨 Serve configuration incomplete for profile '{}'",
                    profile_name_clone
                );
                notify(
                    &app_clone,
                    "Serve Failed",
                    &format!(
                        "Serve configuration incomplete for profile '{}'",
                        profile_name_clone
                    ),
                );
                return;
            }
        };

        match start_serve(app_clone.clone(), job_cache_state.clone(), params).await {
            Ok(response) => {
                info!(
                    "✅ Started serve for {} profile '{}' at {}",
                    remote_name_clone, profile_name_clone, response.addr
                );
                notify(
                    &app_clone,
                    "Serve Started",
                    &format!(
                        "Started serve for {} profile '{}' at {}",
                        remote_name_clone, profile_name_clone, response.addr
                    ),
                );
            }
            Err(e) => {
                error!(
                    "🚨 Failed to start serve for {} profile '{}': {}",
                    remote_name_clone, profile_name_clone, e
                );
                notify(
                    &app_clone,
                    "Serve Failed",
                    &format!(
                        "Failed to start serve for {} profile '{}': {}",
                        remote_name_clone, profile_name_clone, e
                    ),
                );
            }
        }
    });
}

pub fn handle_stop_serve_profile(app: AppHandle, _remote_name: &str, serve_id: &str) {
    let app_clone = app.clone();
    let serve_id_clone = serve_id.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let all_serves = cache.get_serves().await;
        let remote_name = all_serves
            .iter()
            .find(|s| s.id == serve_id_clone)
            .and_then(|s| s.params["fs"].as_str())
            .map(|fs| fs.split(':').next().unwrap_or("").to_string())
            .unwrap_or_else(|| "unknown_remote".to_string());

        match stop_serve(
            app_clone.clone(),
            serve_id_clone.clone(),
            remote_name.clone(),
            app_clone.state(),
        )
        .await
        {
            Ok(_) => {
                info!("🛑 Stopped serve {serve_id_clone} for {remote_name}");
                notify(
                    &app_clone,
                    "Serve Stopped",
                    &format!("Stopped serve for {remote_name}"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to stop serve {serve_id_clone}: {e}");
                notify(
                    &app_clone,
                    "Stop Serve Failed",
                    &format!("Failed to stop serve for {remote_name}: {e}"),
                );
            }
        }
    });
}

// ========== GLOBAL ACTIONS ==========

pub fn handle_stop_all_jobs(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let job_cache_state = app.state::<JobCache>();
        let active_jobs = job_cache_state.get_active_jobs().await;
        if active_jobs.is_empty() {
            return;
        }
        for job in active_jobs.clone() {
            let scheduled_cache = app.state::<ScheduledTasksCache>();
            match stop_job(
                app.clone(),
                job_cache_state.clone(),
                scheduled_cache,
                job.jobid,
                job.remote_name.clone(),
                app.state(),
            )
            .await
            {
                Ok(_) => {
                    info!("🛑 Stopped job {}", job.jobid);
                }
                Err(e) => {
                    error!("🚨 Failed to stop job {}: {}", job.jobid, e);
                }
            }
        }
        notify(
            &app,
            "All Jobs Stopped",
            &format!("Stopped {} active jobs", active_jobs.len()),
        );
    });
}

pub fn handle_browse_remote(app: &AppHandle, remote_name: &str) {
    let remote = remote_name.to_string();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = settings_val.get(&remote).cloned().unwrap_or_else(|| {
            error!("🚨 Remote {remote} not found in cached settings");
            serde_json::Value::Null
        });

        // Try to get first mount point from mountConfigs
        let mount_point = settings
            .get("mountConfigs")
            .and_then(|v| v.as_array())
            .and_then(|configs| configs.first())
            .and_then(|config| config.get("dest"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        match app_clone.opener().open_path(mount_point, None::<&str>) {
            Ok(_) => {
                info!("📂 Opened file manager for {remote}");
            }
            Err(e) => {
                error!("🚨 Failed to open file manager for {remote}: {e}");
            }
        }
    });
}

pub fn handle_stop_all_serves(app: AppHandle) {
    info!("🛑 Stopping all active serves from tray action");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        match stop_all_serves(app_clone.clone(), app_clone.state(), "menu".to_string()).await {
            Ok(_) => {
                info!("✅ All serves stopped successfully");
                notify(&app_clone, "All Serves Stopped", "All serves stopped");
            }
            Err(e) => {
                error!("🚨 Failed to stop all serves: {e}");
                notify(
                    &app_clone,
                    "Stop All Serves Failed",
                    &format!("Failed to stop serves: {e}"),
                );
            }
        }
    });
}
