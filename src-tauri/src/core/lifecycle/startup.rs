use log::{debug, error, info};
use tauri::{AppHandle, Manager, Runtime};
use tokio::join;

use crate::rclone::api::{
    api_command::{mount_remote, start_sync},
    state::{get_cached_remotes, get_settings},
};

/// Main entry point for handling startup tasks.
pub async fn handle_startup(app_handle: AppHandle) {
    info!("🚀 Checking startup options...");

    // Run both tasks in parallel
    let (remotes_result, _) = join!(initialize_remotes(), sync_all_remotes(&app_handle));

    // Process remotes after retrieval
    if let Ok(remotes) = remotes_result {
        for remote in remotes.iter() {
            handle_remote_startup(remote.to_string(), app_handle.clone()).await;
        }
    }
}

/// Fetches the list of available remotes.
async fn initialize_remotes() -> Result<Vec<String>, String> {
    let remotes = get_cached_remotes().await?;
    Ok(remotes)
}

/// Formats a remote name with trailing colon if needed
fn format_remote_name(remote_name: &str) -> String {
    if remote_name.ends_with(':') {
        remote_name.to_string()
    } else {
        format!("{}:", remote_name)
    }
}

/// Handles startup logic for an individual remote.
async fn handle_remote_startup(remote_name: String, app_handle: AppHandle) {
    let settings_result = get_settings().await;
    let settings = settings_result
        .ok()
        .and_then(|settings| settings.get(&remote_name).cloned())
        .unwrap_or_else(|| {
            error!("Remote {} not found in cached settings", remote_name);
            serde_json::Value::Null
        });

    let mount_options = settings.get("mountConfig").cloned();
    let vfs_options = settings.get("vfsConfig").cloned();
    let sync_config = settings.get("syncConfig").cloned();
    let filter_options = settings.get("filterConfig").cloned();

    // Handle auto-mount if configured
    if let Some(auto_mount) = mount_options
        .as_ref()
        .and_then(|opts| opts.get("autoMount").and_then(|v| v.as_bool()))
    {
        if auto_mount {
            let mount_point = mount_options
                .as_ref()
                .and_then(|opts| opts.get("dest").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let source = mount_options
                .as_ref()
                .and_then(|opts| opts.get("source").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .unwrap_or_default(); // Default to empty string if no source

            if let Some(dest) = mount_point {
                let formatted_remote = format_remote_name(&remote_name);
                spawn_mount_task(
                    formatted_remote,
                    source,
                    dest,
                    mount_options,
                    vfs_options,
                    app_handle.clone(),
                );
            } else {
                error!("❌ Mount configuration incomplete for {}", remote_name);
            }
        } else {
            debug!("Skipping mount for {}: autoMount is not true", remote_name);
        }
    }

    // Handle auto-sync if configured
    if let Some(auto_sync) = sync_config
        .as_ref()
        .and_then(|opts| opts.get("autoSync").and_then(|v| v.as_bool()))
    {
        if auto_sync {
            let source = sync_config
                .as_ref()
                .and_then(|opts| opts.get("source").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let dest_path = sync_config
                .as_ref()
                .and_then(|opts| opts.get("dest").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let sync_options = sync_config
                .as_ref()
                .and_then(|opts| opts.get("options").cloned());

            if let Some(dest) = dest_path {
                let formatted_remote = format_remote_name(&remote_name);
                let source = source.unwrap_or_default(); // Default to empty string if no source

                spawn_sync_task(
                    formatted_remote,
                    source,
                    dest,
                    sync_options,
                    filter_options,
                    app_handle,
                );
            } else {
                error!("❌ Sync configuration incomplete for {}", remote_name);
            }
        } else {
            debug!("Skipping sync for {}: autoSync is not true", remote_name);
        }
    }
}

/// Spawns an async task to mount a remote.
fn spawn_mount_task(
    remote_name: String,
    source: String,
    mount_point: String,
    mount_options: Option<serde_json::Value>,
    vfs_options: Option<serde_json::Value>,
    app_handle: AppHandle,
) {
    let app_clone = app_handle.clone();
    let mount_options_clone = mount_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    let vfs_options_clone = vfs_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    tauri::async_runtime::spawn(async move {
        match mount_remote(
            app_clone.clone(),
            remote_name.clone(),
            source.clone(),
            mount_point,
            mount_options_clone,
            vfs_options_clone,
            app_clone.state(),
        )
        .await
        {
            Ok(_) => {
                info!("✅ Mounted {}", format!("{}:{}", remote_name, source));
            }
            Err(err) => error!(
                "❌ Failed to mount {}: {}",
                format!("{}:{}", remote_name, source),
                err
            ),
        }
    });
}

/// Spawns an async task to sync a remote.
fn spawn_sync_task(
    remote_name: String,
    source: String,
    dest_path: String,
    sync_config: Option<serde_json::Value>,
    filter_options: Option<serde_json::Value>,
    app_handle: AppHandle,
) {
    let app_clone = app_handle.clone();
    let sync_config_map = sync_config
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    let filter_options_map = filter_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    tauri::async_runtime::spawn(async move {
        match start_sync(
            app_clone.clone(),
            remote_name.clone(),
            source.clone(),
            dest_path,
            sync_config_map,
            filter_options_map,
            app_clone.state(),
        )
        .await
        {
            Ok(_) => {
                info!("✅ Synced {}", format!("{}:{}", remote_name, source));
            }
            Err(err) => error!(
                "❌ Failed to sync {}: {}",
                format!("{}:{}", remote_name, source),
                err
            ),
        }
    });
}

/// Runs sync jobs for all remotes.
async fn sync_all_remotes<R: Runtime>(_app_handle: &AppHandle<R>) -> Result<(), String> {
    info!("🔄 Starting remote sync tasks...");

    // Get all remotes and their settings
    let remotes = get_cached_remotes().await?;
    let settings = get_settings().await.map_err(|e| e.to_string())?;

    for remote in remotes {
        if let Some(remote_settings) = settings.get(&remote) {
            if let Some(sync_config) = remote_settings.get("syncConfig") {
                if let Some(auto_sync) = sync_config.get("autoSync").and_then(|v| v.as_bool()) {
                    if auto_sync {
                        info!("🔄 Starting sync for remote: {}", remote);
                        // The actual sync will be handled in handle_remote_startup
                    }
                }
            }
        }
    }

    Ok(())
}
