/// Initialization submodules
pub mod apply_settings;
pub mod automation;
pub mod bootstrap;

use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
#[cfg(not(feature = "librclone"))]
use crate::rclone::backend::types::Backend;
use crate::services::bridge;
use crate::services::lifecycle::startup::autostart_profiles;
use crate::services::security::SafeEnvironmentManager;
use crate::services::settings::AppSettingsManager;
use crate::utils::app::notification::{NotificationEvent, SystemStage, notify};
#[cfg(not(feature = "librclone"))]
use crate::utils::constants::LOCAL_BACKEND_NAME;
use crate::utils::types::events::{APP_EVENT, SYSTEM_SETTINGS_CHANGED};
use crate::utils::types::state::RcloneState;
use log::{debug, error, info};
use serde_json::json;

/// Handles async startup tasks using a phased approach
pub async fn initialization(app_handle: crate::context::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<RcloneState>();
    let _startup = state.initialization_lock.lock().await;
    if state.is_shutting_down() {
        return Ok(());
    }
    if !state
        .initial_startup
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    debug!("Starting async startup tasks");

    let settings_manager = app_handle.state::<AppSettingsManager>();
    if settings_manager.is_locked() {
        info!(
            "Configuration vault is locked. Postponing background initialization until unlocked."
        );
        crate::utils::i18n::init();
        crate::utils::i18n::set_language(
            &app_handle
                .state::<std::sync::Arc<crate::services::settings::access::VaultAccess>>()
                .language(),
        );
        #[cfg(feature = "updater")]
        crate::services::updates::health::core_ready(&app_handle);
        return Ok(());
    }

    let result = initialize_unlocked(app_handle).await;
    if let Err(error) = &result {
        bridge::emit(
            APP_EVENT,
            json!({ "status": "startup_failed", "message": error }),
        );
    }
    result
}

async fn initialize_unlocked(app_handle: AppHandle) -> Result<(), String> {
    let state = app_handle.state::<RcloneState>();
    let session_revision = crate::services::settings::access::revision(&app_handle);

    if let Err(e) = async_core_setup(&app_handle).await {
        error!("Phase 0 Core Setup failed: {e}");
        return Err(e);
    }

    if let Err(e) = bootstrap::init_all(&app_handle).await {
        error!("Phase 1 Bootstrap failed: {e}");
        return Err(e);
    }

    // Required local startup succeeded. Remote availability is not an update failure.
    #[cfg(feature = "updater")]
    crate::services::updates::health::core_ready(&app_handle);

    info!("Phase 2: Checking backend connectivity...");
    check_active_backend_connectivity(&app_handle).await;

    // The engine's post-start setup already refreshed the remote caches and applied the
    // runtime settings; only what it does not cover is loaded here.
    info!("Phase 3: Loading alert rules...");
    load_alert_state(&app_handle).await;

    info!("Phase 4: Starting services...");

    // Automation is optional: when it fails, health monitoring and the profile
    // auto-starts below must still run.
    let autostarts = match automation::initialize_automations(app_handle.clone()).await {
        Ok(autostarts) => Some(autostarts),
        Err(error) => {
            error!("Phase 4 Automation setup failed: {error}");
            // Without it no schedule or watcher runs, so the user has to be told.
            notify(
                &app_handle,
                NotificationEvent::System(SystemStage::AutomationUnavailable { error }),
            );
            None
        }
    };

    crate::services::lifecycle::auto_updater::init_auto_updater(app_handle.clone());

    #[cfg(feature = "tray")]
    {
        if let Err(e) = app_handle.host().setup_tray().await {
            error!("Failed to setup tray: {e}");
        }
    }

    if state.is_shutting_down() {
        return Ok(());
    }
    crate::services::settings::access::require_session(&app_handle, session_revision)?;
    if autostarts.is_some() {
        for failure in start_automation_runtime(&app_handle).await {
            error!("{failure}");
        }
    }
    if state.is_shutting_down() {
        return Ok(());
    }
    crate::services::settings::access::require_session(&app_handle, session_revision)?;
    // Optional remote auto-starts can be slow; monitoring must already be
    // available while those operations are starting.
    crate::rclone::engine::lifecycle::mark_startup_complete(&app_handle);
    #[cfg(target_os = "android")]
    crate::services::lifecycle::keep_alive::request_sync(&app_handle);

    info!("Phase 5: Running post-initialization tasks");
    let remotes = autostarts.map(|autostarts| autostarts.start(&app_handle));
    autostart_profiles(app_handle.clone(), remotes).await;

    info!("Initialization complete");
    Ok(())
}

/// Fully refreshes all system components after settings change or restore.
pub async fn refresh_system(app_handle: AppHandle) -> Result<(), String> {
    info!("Initiating full system refresh...");

    let manager = app_handle.state::<AppSettingsManager>();

    if let Some(runtime) =
        app_handle.try_state::<crate::services::automation::runtime::RuntimeTasks>()
    {
        runtime.invalidate_all();
    }
    manager.invalidate_cache();
    let settings = manager.get_all().map_err(|e| e.to_string())?;

    let backend_manager = app_handle.state::<BackendManager>();
    #[cfg(not(feature = "librclone"))]
    let running_local = backend_manager.get(LOCAL_BACKEND_NAME).await;
    backend_manager
        .load_from_settings(manager.inner())
        .await
        .map_err(|e| format!("Failed to reload backends: {e}"))?;

    // A restore can change where the local engine must listen. Its running
    // process still uses the old address, so move it before refreshing caches.
    #[cfg(not(feature = "librclone"))]
    let restarted = match (running_local, backend_manager.get(LOCAL_BACKEND_NAME).await) {
        (Some(running), Some(saved)) if local_connection_changed(&running, &saved) => {
            crate::rclone::engine::lifecycle::restart_for_config_change_and_wait(
                &app_handle,
                "settings_reload",
            )
            .await;
            true
        }
        _ => false,
    };
    #[cfg(feature = "librclone")]
    let restarted = false;

    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        let _ = env_manager.init_with_stored_credentials(manager.inner());
    }

    // A restarted engine's post-start setup has already refreshed the remote caches. A failed
    // refresh must not leave the rest of the restore unapplied, so it is reported last.
    let cache_result = initialize_caches(&app_handle, !restarted).await;

    crate::services::automation::commands::reload_automations_from_configs(&app_handle).await?;

    app_handle
        .state::<std::sync::Arc<crate::services::settings::access::VaultAccess>>()
        .set_language(&settings.general.language, manager.is_vault_enabled());
    apply_settings::apply_core_settings(&app_handle, &settings).await;

    bridge::emit(
        crate::utils::types::events::REMOTE_SETTINGS_CHANGED,
        crate::utils::constants::CACHE_UPDATED,
    );
    bridge::emit(
        SYSTEM_SETTINGS_CHANGED,
        crate::utils::types::events::SettingsChangeEvent {
            category: "*".to_string(),
            key: "*".to_string(),
            value: serde_json::Value::Null,
        },
    );

    cache_result?;
    info!("System successfully refreshed");
    Ok(())
}

/// Whether the engine started with `running` must be restarted to match `saved`.
#[cfg(not(feature = "librclone"))]
fn local_connection_changed(running: &Backend, saved: &Backend) -> bool {
    running.host != saved.host
        || running.port != saved.port
        || running.username != saved.username
        || running.password != saved.password
        || running.config_path != saved.config_path
        || running.config_password != saved.config_password
}

/// Reloads alerts and, unless `refresh_remotes` is false, the remote caches after a
/// settings change or restore. Alerts load even when the remote refresh fails.
async fn initialize_caches(app_handle: &AppHandle, refresh_remotes: bool) -> Result<(), String> {
    let mut result = Ok(());
    if refresh_remotes {
        info!("Refreshing caches...");
        let backend_manager = app_handle.state::<BackendManager>();
        let backend = backend_manager.get_active().await;
        result = backend_manager
            .remote_cache_for(&backend.name)
            .refresh_all(app_handle.clone(), &backend)
            .await;
        match &result {
            Ok(()) => debug!("Refreshed backend caches"),
            Err(e) => error!("Failed to refresh backend caches: {e}"),
        }
    }

    load_alert_state(app_handle).await;
    result
}

/// Seeds the default alerts and loads the alert rules and actions.
async fn load_alert_state(app_handle: &AppHandle) {
    let manager = app_handle.state::<AppSettingsManager>();
    #[cfg(feature = "notifications")]
    if let Err(e) = crate::services::alerts::seed::seed_defaults(manager.inner()) {
        error!("Failed to seed alert defaults: {e}");
    }

    let alert_cache = app_handle.state::<crate::services::alerts::cache::AlertRuleCache>();
    alert_cache.reload_rules(manager.inner()).await;
    alert_cache.reload_actions(manager.inner()).await;
    debug!("Alert rules and actions loaded");
}

/// Starts the file watchers and the cron scheduler. Neither is required for the
/// app to work, so their failures are returned for logging instead of aborting
/// startup. A watched folder that is missing (an unplugged drive) is one of them.
async fn start_automation_runtime(app_handle: &AppHandle) -> Vec<String> {
    let mut failures = Vec::new();
    if let Err(e) = app_handle
        .state::<crate::services::automation::watcher::WatcherManager>()
        .sync_watchers(app_handle.clone())
        .await
    {
        failures.push(format!("File watchers are not fully active: {e}"));
    }
    if let Err(e) = app_handle
        .state::<crate::services::automation::engine::AutomationScheduler>()
        .start()
        .await
    {
        failures.push(format!("Cron scheduler did not start: {e}"));
    }
    failures
}

const BACKEND_CONNECTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

async fn check_active_backend_connectivity(app_handle: &crate::context::AppHandle) {
    let backend_manager = app_handle.state::<BackendManager>();

    let active_name = backend_manager.get_active_name().await;

    if crate::rclone::backend::types::Backend::is_local_name(&active_name) {
        // The engine's post-start setup records the Local status. Marking it
        // connected here would also hide an engine that failed to start.
        info!("Skipping Local backend connectivity check (verified during engine startup)");
    } else {
        info!(
            "Active backend '{active_name}' is remote — spawning connectivity probe in background so UI can load immediately"
        );
        let app_clone = app_handle.clone();
        crate::utils::spawn(async move {
            let backend_manager = app_clone.state::<BackendManager>();
            let transport = app_clone.state::<RcloneState>().transport.clone();
            crate::rclone::backend::connectivity::ensure_connectivity(
                &backend_manager,
                &*transport,
                BACKEND_CONNECTIVITY_TIMEOUT,
            )
            .await;
        });
    }
}

/// Phase 0: Core Setup - Initializes logging, i18n, and security.
async fn async_core_setup(app_handle: &AppHandle) -> Result<(), String> {
    info!("Phase 0: Initializing core services...");

    let rcman_manager = app_handle.state::<AppSettingsManager>();

    let settings = rcman_manager
        .get_all()
        .map_err(|e| format!("Failed to load settings during Phase 0: {e}"))?;

    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        debug!("Initializing environment manager credentials...");
        if let Err(e) = env_manager.init_with_stored_credentials(rcman_manager.inner()) {
            error!("Failed to initialize environment manager: {e}");
        }
    }
    crate::utils::i18n::init();
    crate::utils::i18n::set_language(&settings.general.language);
    app_handle
        .state::<std::sync::Arc<crate::services::settings::access::VaultAccess>>()
        .set_language(&settings.general.language, rcman_manager.is_vault_enabled());

    debug!("Initializing logging...");
    crate::utils::logging::log::init_logging(&settings.developer.log_level, app_handle.clone())
        .map_err(|e| format!("Failed to initialize logging: {e}"))?;

    #[cfg(all(
        any(feature = "autostart", feature = "flatpak"),
        not(any(target_os = "android", target_os = "ios"))
    ))]
    if settings.general.start_on_startup {
        app_handle.host().sync_autostart();
    }

    info!("Phase 0 Core Setup complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "librclone"))]
    #[test]
    fn a_restored_local_address_or_credential_restarts_the_engine() {
        let running = Backend::new_local(LOCAL_BACKEND_NAME);
        assert!(!local_connection_changed(&running, &running.clone()));

        let mut moved = running.clone();
        moved.port += 1;
        assert!(local_connection_changed(&running, &moved));

        let mut credentials = running.clone();
        credentials.password = Some("restored".into());
        assert!(local_connection_changed(&running, &credentials));

        let mut config = running.clone();
        config.config_path = Some("/restored/rclone.conf".into());
        assert!(local_connection_changed(&running, &config));
    }
    use crate::rclone::state::automations::AutomationsCache;
    use crate::services::automation::{engine::AutomationScheduler, watcher::WatcherManager};

    fn automation_app() -> AppHandle {
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        app.manage(AutomationsCache::new());
        app.manage(WatcherManager::new());
        app.manage(AutomationScheduler::new());
        app
    }

    #[tokio::test]
    async fn an_idle_automation_runtime_reports_only_the_uninitialized_scheduler() {
        let app = automation_app();

        let failures = start_automation_runtime(&app).await;

        assert_eq!(failures.len(), 1);
        assert!(failures[0].starts_with("Cron scheduler did not start"));
    }

    #[tokio::test]
    async fn a_missing_watch_folder_is_reported_instead_of_aborting_startup() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("unplugged-drive");
        let app = automation_app();
        let config: crate::utils::types::remotes::RemoteSettings =
            serde_json::from_value(serde_json::json!({
                "name": "drive",
                "syncConfigs": {"Default": {
                    "app": {"watchEnabled": true, "watchDelay": 0},
                    "rclone": {"srcFs": missing, "dstFs": "drive:"}
                }}
            }))
            .unwrap();
        app.state::<AutomationsCache>()
            .add_or_update_automation_for_remote("Local", "drive", &config)
            .await
            .unwrap();

        let failures = start_automation_runtime(&app).await;

        assert!(
            failures
                .iter()
                .any(|failure| failure.starts_with("File watchers are not fully active")),
            "{failures:?}"
        );
        assert!(
            failures
                .iter()
                .any(|failure| failure.starts_with("Cron scheduler did not start")),
            "{failures:?}"
        );
    }
}
