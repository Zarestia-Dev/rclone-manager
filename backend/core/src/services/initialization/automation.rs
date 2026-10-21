use crate::context::AppHandle;
use log::info;

use crate::{
    rclone::{backend::BackendManager, state::automations::AutomationsCache},
    services::{
        automation::{engine::AutomationScheduler, runtime::RuntimeTasks},
        settings::AppSettingsManager,
    },
};

/// Initialize the cron scheduler with tasks loaded from remote configs.
pub async fn initialize_automations(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<AutomationsCache>();
    let scheduler_state = app_handle.state::<AutomationScheduler>();
    let manager = app_handle.state::<AppSettingsManager>();
    let revision = app_handle.state::<RuntimeTasks>().revision();

    let backend_manager = app_handle.state::<BackendManager>();
    let (backend, all_settings) = backend_manager.active_remote_configs(manager.inner()).await;

    info!("📋 Loading automations from remote configs...");

    let backend_name = backend.name.clone();
    let quick_runs = crate::services::flow::quick_run::commands::get_all_quick_runs_sync(&manager)?;
    let workflows = crate::services::flow::workflow::commands::get_all_workflows_sync(&manager)?;

    let result = cache_state
        .load_from_remote_configs(&all_settings, &backend_name)
        .await?;

    info!("📅 Loaded {} remote automation(s)", result.added.len());

    // ── Quick Run Automations ───────────────────────────────────────────────
    info!("🚀 Syncing {} Quick Run(s)...", quick_runs.len());

    cache_state
        .load_from_quick_runs(&quick_runs, &backend_name)
        .await?;

    for qr in &quick_runs {
        if qr.is_autostart() {
            info!("⚡ Auto-starting Quick Run: {} ({})", qr.name, qr.id);
            let app = app_handle.clone();
            let qr_id = qr.id.clone();
            let backend = backend.clone();
            crate::utils::spawn(async move {
                if let Err(e) =
                    crate::services::flow::quick_run::commands::start_quick_run_on_backend(
                        app,
                        backend,
                        qr_id.clone(),
                        None,
                        None,
                        None,
                    )
                    .await
                {
                    log::error!("Failed to auto-start Quick Run {qr_id}: {e}");
                }
            });
        }
    }

    // ── Workflow Automations ───────────────────────────────────────────────
    info!("🌀 Syncing {} Workflow(s)...", workflows.len());

    cache_state
        .load_from_workflows(&workflows, &backend_name)
        .await?;

    for wf in &workflows {
        if wf.is_autostart() {
            let delay = wf.app_start_delay_seconds();
            info!(
                "⚡ Auto-starting Workflow: {} ({}) with {delay}s delay",
                wf.name, wf.id
            );
            let app = app_handle.clone();
            let wf_id = wf.id.clone();
            let backend = backend.clone();
            crate::utils::spawn(async move {
                if let Err(e) = crate::services::flow::workflow::engine::execute_workflow(
                    app,
                    backend,
                    wf_id.clone(),
                    false,
                )
                .await
                {
                    log::error!("Failed to auto-start Workflow {wf_id}: {e}");
                }
            });
        }
    }

    crate::services::automation::runtime::refresh_with_definitions(
        &app_handle,
        Some(revision),
        Some(quick_runs),
        Some(workflows),
    )
    .await?;
    scheduler_state.initialize(app_handle.clone()).await?;
    scheduler_state.start().await?;
    crate::services::automation::engine::apply_and_sync_automations(&app_handle).await
}
