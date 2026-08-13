use log::info;
use tauri::{AppHandle, Manager};

use crate::{
    core::{
        automation::{engine::AutomationScheduler, watcher::WatcherManager},
        settings::AppSettingsManager,
    },
    rclone::{backend::BackendManager, state::automations::AutomationsCache},
};

use crate::core::settings::remote::manager::get_all_remote_settings_sync;

/// Initialize the cron scheduler with tasks loaded from remote configs.
pub async fn initialize_automations(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<AutomationsCache>();
    let scheduler_state = app_handle.state::<AutomationScheduler>();
    let manager = app_handle.state::<AppSettingsManager>();

    let backend_manager = app_handle.state::<BackendManager>();
    let remote_names = backend_manager.remote_cache.get_remotes().await;

    let all_settings = get_all_remote_settings_sync(manager.inner(), &remote_names);

    info!("📋 Loading automations from remote configs...");

    let backend_name = backend_manager.get_active_name().await;

    let result = cache_state
        .load_from_remote_configs(&all_settings, &backend_name, Some(&app_handle))
        .await?;

    for automation in &result.removed {
        if let Some(job_id_str) = &automation.scheduler_job_id
            && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
        {
            let _ = scheduler_state.unschedule_automation(job_id).await;
        }
    }

    info!("📅 Loaded {} automation(s)", result.added.len());

    scheduler_state.initialize(app_handle.clone()).await?;
    scheduler_state.start().await?;
    scheduler_state
        .reload_automations(app_handle.clone())
        .await?;

    let watcher_manager = app_handle.state::<WatcherManager>();
    if let Err(e) = watcher_manager.sync_watchers(app_handle.clone()).await {
        log::error!("Failed to initialize watchers: {e}");
    }

    // ── Quick Run Automations & Watchers ────────────────────────────────────
    if let Ok(quick_runs) =
        crate::core::flow::quick_run::commands::get_all_quick_runs_sync(&manager)
    {
        info!("🚀 Syncing {} Quick Run(s)...", quick_runs.len());

        for qr in &quick_runs {
            if qr.is_autostart() {
                info!("⚡ Auto-starting Quick Run: {} ({})", qr.name, qr.id);
                let app = app_handle.clone();
                let qr_id = qr.id.clone();
                tokio::spawn(async move {
                    if let Err(e) =
                        crate::core::flow::quick_run::commands::start_quick_run(app, qr_id.clone())
                            .await
                    {
                        log::error!("Failed to auto-start Quick Run {qr_id}: {e}");
                    }
                });
            }
        }

        if let Err(e) = scheduler_state.sync_quick_runs(app_handle.clone()).await {
            log::error!("Failed to sync Quick Run scheduler: {e}");
        }

        if let Err(e) = watcher_manager
            .sync_quick_run_watchers(app_handle.clone())
            .await
        {
            log::error!("Failed to sync Quick Run watchers: {e}");
        }
    }

    Ok(())
}
