use log::{debug, error, info, warn};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(feature = "librclone")]
use crate::utils::rclone::endpoints::core;
use crate::utils::{
    app::notification::{EngineStage, NotificationEvent, notify},
    types::{
        events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED},
        state::{EnginePhase, EngineState, RcApiEngine, RcloneState},
    },
};

use super::error::EngineError;
#[cfg(not(feature = "librclone"))]
use super::monitoring::{HealthStatus, WaitReadyError};
#[cfg(not(feature = "librclone"))]
use crate::rclone::backend::BackendManager;

pub fn mark_startup_complete(app: &AppHandle) {
    let state = app.state::<RcloneState>();
    state.initial_startup.store(false, Ordering::Release);
    debug!("Initial startup complete, health monitoring enabled");
}

#[cfg(not(feature = "librclone"))]
const API_READY_TIMEOUT_SECS: u64 = 10;

impl RcApiEngine {
    pub async fn init(&mut self, app: &AppHandle) {
        if self.validate_config(app).await {
            start(self, app).await;
        } else {
            warn!("Engine startup aborted due to configuration validation failure");
        }
    }

    pub async fn shutdown(&mut self, _app: &AppHandle) {
        info!("Shutting down Rclone engine");
        self.mark_stopping();

        // Desktop: kill the rcd child process via core/quit + force-kill.
        #[cfg(not(feature = "librclone"))]
        {
            if let Err(e) = self.kill_process(_app).await {
                error!("Failed to stop engine cleanly: {e}");
            }
            self.process = None;
        }

        // Mobile: finalize librclone (releases Go runtime resources).
        // Safe to call even if not initialized; RcloneFinalize is idempotent.
        #[cfg(feature = "librclone")]
        {
            crate::rclone::backend::rclone_ffi::finalize();
        }

        self.mark_stopped();
    }
}

#[cfg(not(feature = "librclone"))]
pub async fn set_engine_updating(app: &AppHandle, updating: bool) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.set_updating(updating);
}

#[cfg(not(feature = "librclone"))]
pub async fn shutdown_engine(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.shutdown(app).await;
}

#[cfg(not(feature = "librclone"))]
pub async fn resume_engine(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.clear_errors();
    if matches!(engine.phase, EnginePhase::Updating) {
        engine.mark_stopped();
    }
}

/// Clear the engine's failed state so the next `start()` attempt can proceed.
///
/// This is called when switching backends — a failure from the *old* backend
/// (e.g. `FailedOther "remote unreachable"`, `FailedAuth`, `FailedPassword`)
/// is irrelevant to the *new* backend. Without this, `start()` sees the
/// stale `start_block_reason()` and bails out immediately, leaving the engine
/// stuck until the app restarts.
///
/// Works on both desktop and mobile (librclone) since `clear_errors` is
/// platform-agnostic. The `Updating` phase handling is desktop-only and
/// lives in [`resume_engine`].
pub async fn clear_engine_errors(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    let was_failed = engine.phase.is_failed();
    engine.clear_errors();
    drop(engine);
    if was_failed {
        log::info!("Cleared stale engine error state before backend switch retry");
    }
}

/// Tauri command: clear the engine's auth-failed (or any failed) state and
/// immediately retry `start_engine_if_not_running`.
///
/// Called from the repair sheet's "Clear & Retry" button when the user has
/// fixed the backend credentials and wants the engine to retry without
/// restarting the whole app.
#[tauri::command]
pub async fn clear_engine_auth_error(app: AppHandle) -> Result<(), String> {
    log::info!("Clearing engine auth error and retrying start");
    clear_engine_errors(&app).await;
    start_engine_if_not_running(&app).await;
    Ok(())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EngineStatusInfo {
    pub running: bool,
    pub should_exit: bool,
    pub updating: bool,
    pub auth_failed: bool,
}

impl From<&EnginePhase> for EngineStatusInfo {
    fn from(phase: &EnginePhase) -> Self {
        Self {
            running: phase.is_operational(),
            should_exit: phase.is_shutting_down(),
            #[cfg(not(feature = "librclone"))]
            updating: matches!(phase, EnginePhase::Updating),
            #[cfg(feature = "librclone")]
            updating: false,
            auth_failed: phase.is_auth_failure(),
        }
    }
}

impl EngineStatusInfo {
    #[must_use]
    pub fn is_inactive(self) -> bool {
        !self.running || self.updating || self.should_exit
    }
}

pub async fn get_engine_status(app: &AppHandle) -> EngineStatusInfo {
    let state = app.state::<EngineState>();
    let engine = state.lock().await;
    EngineStatusInfo::from(&engine.phase)
}

pub async fn start_engine_if_not_running(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    if !engine.is_running() {
        engine.init(app).await;
    }
}

pub async fn mark_engine_dead(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.mark_stopped();
}

/// Re-emit the current engine phase as a block status event.
///
/// Used by callers (e.g. the poller) that mutate the engine phase directly
/// and need the frontend / notifications to pick up the new state without
/// going through `start()`.
pub async fn emit_block_status_for_phase(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let engine = state.lock().await;
    let phase = engine.phase.clone();
    drop(engine);
    emit_block_status(app, &phase);
}

pub async fn start(engine: &mut RcApiEngine, app: &AppHandle) {
    if let Some(blocking_phase) = engine.start_block_reason() {
        debug!("Engine cannot start: {blocking_phase}");
        emit_block_status(app, blocking_phase);
        return;
    }

    #[cfg(feature = "librclone")]
    start_librclone(engine, app).await;
    #[cfg(not(feature = "librclone"))]
    start_daemon(engine, app).await;
}

fn emit_block_status(app: &AppHandle, phase: &EnginePhase) {
    match phase {
        EnginePhase::FailedPassword => {
            notify(
                app,
                NotificationEvent::Engine(EngineStage::PasswordRequired),
            );
        }
        EnginePhase::FailedAuth { message } => {
            notify(
                app,
                NotificationEvent::Engine(EngineStage::AuthFailed {
                    error: message.clone(),
                }),
            );
        }
        #[cfg(not(feature = "librclone"))]
        EnginePhase::FailedPath => {
            notify(app, NotificationEvent::Engine(EngineStage::BinaryNotFound));
        }
        #[cfg(not(feature = "librclone"))]
        EnginePhase::FailedVersion { .. } => {}
        #[cfg(not(feature = "librclone"))]
        EnginePhase::Updating => {}
        EnginePhase::FailedOther { .. } => {}
        _ => {}
    }

    let status: EngineStatus = phase.into();
    app.emit(RCLONE_ENGINE_STATUS_CHANGED, status).ok();
}

/// Desktop path: decide whether we need to spawn / respawn the rcd daemon,
/// or simply connect to an already-running one.
///
/// Decision tree:
///
/// 1. **Probe the active backend's API** (regardless of whether we own a child
///    process). The previous implementation only treated the API as healthy
///    if `self.process.is_some()` AND alive — so a leftover rcd from a prior
///    session (or an external remote rcd) was always reported as "not healthy"
///    and the code blindly tried to spawn a new one. That broke remote
///    backends and caused the "stuck on 401" loop.
///
/// 2. Branch on `HealthStatus`:
///    * `Healthy`      → reuse it, skip the spawn, run post-start.
///    * `AuthRequired` →
///        - local backend: kill the stale rcd (it has different credentials)
///          and spawn our own with fresh auth.
///        - remote backend: terminal failure — we cannot respawn someone
///          else's rcd. Mark `FailedAuth` and surface the error to the UI.
///    * `Unreachable`  → spawn a new rcd (local only). For remote backends
///      this is also a terminal failure.
///
/// 3. For local backends only, run the existing `spawn_process` +
///    `wait_until_ready` flow. `wait_until_ready` now fails fast on
///    `AuthRequired` instead of looping until the 10s timeout — the rcd we
///    just spawned should accept our credentials, so a 401 here means the
///    password generation / config injection is broken.
#[cfg(not(feature = "librclone"))]
async fn start_daemon(engine: &mut RcApiEngine, app: &AppHandle) {
    let backend_manager = app.state::<BackendManager>();
    let is_local = backend_manager.is_active_local().await;
    let backend = backend_manager.get_active().await;
    debug!(
        "start_daemon: backend '{}' (is_local={is_local}) at {}:{}",
        backend.name, backend.host, backend.port
    );

    // Step 1: probe the API *before* touching any process. This is what lets
    // us connect to an existing rcd instead of always respawning.
    let health = engine.probe_api_health(app).await;
    match health {
        HealthStatus::Healthy => {
            debug!("API is already healthy, skipping restart");
            engine.mark_running();
            super::post_start::run_post_start_setup(app).await;
            return;
        }
        HealthStatus::AuthRequired => {
            if !is_local {
                // Remote backend rejected our credentials. We cannot respawn
                // it — the user has to fix the username/password.
                let msg = format!(
                    "Remote backend '{}' at {}:{} rejected RC API credentials (HTTP 401)",
                    backend.name, backend.host, backend.port
                );
                error!("{msg}");
                engine.mark_auth_failed(msg.clone());
                emit_block_status(app, &engine.phase);
                return;
            }
            // Local backend: there's a stale rcd on our port with different
            // credentials. Kill it and spawn our own below.
            warn!(
                "Local port {} has an rcd that rejected our credentials — \
                 killing and respawning with fresh auth",
                backend.port
            );
        }
        HealthStatus::Unreachable => {
            if !is_local {
                // Remote backend is down / wrong host / wrong port.
                let msg = format!(
                    "Remote backend '{}' at {}:{} is unreachable",
                    backend.name, backend.host, backend.port
                );
                error!("{msg}");
                engine.mark_other_failed(msg);
                emit_block_status(app, &engine.phase);
                return;
            }
            // Local backend: nothing is listening on the port. Good — spawn
            // our own rcd below.
            debug!("Local port {} is free; spawning fresh rcd", backend.port);
        }
    }

    // Step 2 (local only): tear down anything still tracked / bound to the port.
    if engine.process.is_some() {
        debug!("Tracked rclone process exists, stopping first");
        if let Err(e) = engine.kill_process(app).await {
            error!("Failed to stop Rclone process: {e}");
        }
    }

    if let Err(e) = engine.kill_port_processes() {
        error!("Failed to clean up port processes: {e}");
    }

    if matches!(health, HealthStatus::AuthRequired) {
        match engine.probe_api_health(app).await {
            HealthStatus::AuthRequired => {
                let msg = format!(
                    "Port {} is still occupied by an rclone process we couldn't stop \
                     (likely owned by another user or already dead but holding the socket). \
                     Please stop it manually (e.g. `kill -9` the PID from `lsof -i :{}`) \
                     or change the backend port in settings.",
                    backend.port, backend.port
                );
                error!("{msg}");
                engine.mark_other_failed(msg);
                emit_block_status(app, &engine.phase);
                return;
            }
            HealthStatus::Healthy => {
                warn!(
                    "Port {} became healthy after kill — reusing existing rcd",
                    backend.port
                );
                engine.mark_running();
                super::post_start::run_post_start_setup(app).await;
                return;
            }
            HealthStatus::Unreachable => {
                debug!("Port {} is now free after kill", backend.port);
            }
        }
    }

    // Step 3: spawn the new rcd and wait for readiness.
    engine.mark_starting();
    match engine.spawn_process(app).await {
        Ok(child) => {
            engine.process = Some(child);

            match engine.wait_until_ready(app, API_READY_TIMEOUT_SECS).await {
                Ok(()) => {
                    engine.mark_running();
                    info!("Rclone API started on port {}", engine.current_api_port);
                    super::post_start::run_post_start_setup(app).await;
                }
                Err(WaitReadyError::RcAuthFailed) => {
                    error!("Newly spawned rcd rejected our credentials");
                    engine.process = None;
                    let _ = engine.kill_process(app).await;
                    engine.mark_auth_failed(
                        "Spawned rcd rejected credentials (HTTP 401)".to_string(),
                    );
                    emit_block_status(app, &engine.phase);
                }
                Err(WaitReadyError::ProcessDied) => {
                    error!("Rclone process exited during startup");
                    engine.process = None;
                    let _ = engine.kill_process(app).await;
                    handle_start_failure(
                        engine,
                        app,
                        "Rclone process exited during startup (check rclone log)".to_string(),
                    )
                    .await;
                }
                Err(WaitReadyError::Timeout) => {
                    error!("Failed to start Rclone API within {API_READY_TIMEOUT_SECS}s");
                    engine.process = None;
                    let _ = engine.kill_process(app).await;
                    handle_start_failure(
                        engine,
                        app,
                        format!("Timeout waiting for API readiness ({API_READY_TIMEOUT_SECS}s)"),
                    )
                    .await;
                }
            }
        }
        Err(e) => {
            handle_start_failure(engine, app, e.to_string()).await;
        }
    }
}

#[cfg(feature = "librclone")]
async fn start_librclone(engine: &mut RcApiEngine, app: &AppHandle) {
    let transport = app.state::<RcloneState>().transport.clone();
    match transport.rpc(core::VERSION, None).await {
        Ok(_) => {
            engine.mark_running();
            info!("librclone transport ready (in-process)");
            super::post_start::run_post_start_setup(app).await;
        }
        Err(e) => {
            error!("librclone transport not responsive: {e}");
            handle_start_failure(engine, app, format!("librclone init failed: {e}")).await;
        }
    }
}

async fn handle_start_failure(engine: &mut RcApiEngine, app: &AppHandle, e: String) {
    error!("Failed to spawn Rclone process: {e}");

    if !engine.phase.is_failed() {
        engine.mark_other_failed(e);
    }

    emit_block_status(app, &engine.phase);
}

pub fn restart_for_config_change(app: &AppHandle, change_type: &str) {
    info!("Restarting engine due to {change_type} change");

    let app = app.clone();
    let change_type = change_type.to_string();

    tauri::async_runtime::spawn(async move {
        match restart_engine(&app, &change_type).await {
            Ok(()) => {
                info!("Engine restarted for {change_type} change");
                app.emit(
                    RCLONE_ENGINE_STATUS_CHANGED,
                    EngineStatus::Restarted {
                        reason: change_type,
                    },
                )
                .ok();
                notify(&app, NotificationEvent::Engine(EngineStage::Restarted));
            }
            Err(e) => {
                error!("Failed to restart engine for {change_type} change: {e}");
                app.emit(
                    RCLONE_ENGINE_STATUS_CHANGED,
                    EngineStatus::Error {
                        message: e.to_string(),
                    },
                )
                .ok();
                notify(
                    &app,
                    NotificationEvent::Engine(EngineStage::RestartFailed {
                        error: e.to_string(),
                    }),
                );
            }
        }
    });
}

async fn restart_engine(app: &AppHandle, change_type: &str) -> super::error::EngineResult<()> {
    let engine_state = app.state::<EngineState>();
    let mut engine = engine_state.lock().await;

    // Desktop: kill the daemon process before restart.
    // Mobile: librclone is in-process — "restart" = finalize + re-initialize
    // (cheap), which clears all rclone state (remotes, VFS caches, in-flight
    // jobs) and starts fresh.
    #[cfg(not(feature = "librclone"))]
    {
        if let Err(e) = engine.kill_process(app).await {
            error!("Failed to stop engine cleanly during restart: {e}");
        }
    }
    #[cfg(feature = "librclone")]
    {
        log::info!("Restarting librclone (finalize + initialize) for {change_type} change");
        crate::rclone::backend::rclone_ffi::finalize();
        crate::rclone::backend::rclone_ffi::initialize();
    }

    if !engine.validate_config(app).await {
        return Err(EngineError::ConfigValidationFailed(format!(
            "Configuration validation failed after {change_type} change"
        )));
    }

    start(&mut engine, app).await;

    if engine.is_running() {
        Ok(())
    } else {
        Err(EngineError::RestartFailed(
            "Engine failed to start after restart".to_string(),
        ))
    }
}
