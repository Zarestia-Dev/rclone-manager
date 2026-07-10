use log::{error, info};
use tauri::{AppHandle, Emitter, Manager};

use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::utils::types::events::SYSTEM_STATUS;
use crate::utils::types::monitoring::SystemStatusPayload;
use crate::utils::types::rclone::ProcessKind;
use crate::utils::types::state::{RcApiEngine, RcloneState};
use crate::utils::{
    process::process_manager::kill_processes_on_port,
    rclone::{
        endpoints::core,
        process_common::{build_rclone_process_command, graceful_shutdown},
    },
};

use super::error::{EngineError, EngineResult};

impl RcApiEngine {
    pub async fn spawn_process(&mut self, app: &AppHandle) -> EngineResult<tokio::process::Child> {
        let backend_manager = app.state::<BackendManager>();
        let backend = backend_manager.get_active().await;

        self.current_api_port = backend.port;

        let engine_cmd = match build_rclone_process_command(app, ProcessKind::Engine).await {
            Ok(cmd) => cmd,
            Err(e) => {
                error!("Failed to create engine command: {e}");
                if let EngineError::PasswordRequired = e {
                    self.mark_password_failed();
                }
                return Err(e);
            }
        };

        match engine_cmd.spawn() {
            Ok(child) => {
                info!("Rclone process spawned");
                #[cfg(not(feature = "librclone"))]
                if matches!(
                    self.phase,
                    crate::utils::types::state::EnginePhase::FailedPath
                ) {
                    self.clear_errors();
                }
                Ok(child)
            }
            Err(e) => {
                error!("Failed to spawn rclone process: {e}");
                if e.kind() == std::io::ErrorKind::NotFound {
                    self.mark_path_failed();
                    return Err(EngineError::InvalidPath);
                }
                self.mark_other_failed(e.to_string());
                Err(EngineError::SpawnFailed(e.to_string()))
            }
        }
    }

    pub async fn kill_process(&mut self, app: &AppHandle) -> EngineResult<()> {
        let Some(mut child) = self.process.take() else {
            self.mark_stopped();
            return Ok(());
        };

        let backend_manager = app.state::<BackendManager>();
        let backend = backend_manager.get_active().await;

        let mut kill_error: Option<EngineError> = None;

        if self.is_running() && child.id().is_some() {
            let state = app.state::<RcloneState>();
            let quit_request = backend.inject_auth(state.client.post(backend.url_for(core::QUIT)));

            if let Err(e) = graceful_shutdown(child, quit_request).await {
                log::warn!("Graceful shutdown failed: {e}");
            }
        } else {
            info!("Force killing engine process");
            if let Err(e) = child.kill().await {
                let msg = format!("Failed to kill process: {e}");
                error!("{msg}");
                kill_error = Some(EngineError::KillFailed(msg));
            }
            let _ = child.wait().await;
        }

        self.mark_stopped();

        if backend.is_auth_generated {
            let mut updated_backend = backend.clone();
            updated_backend.username = None;
            updated_backend.password = None;
            updated_backend.is_auth_generated = false;
            let settings_manager = app.state::<AppSettingsManager>();
            let _ = backend_manager
                .update(&settings_manager, &backend.name, updated_backend)
                .await;
        }

        let _ = app.emit(SYSTEM_STATUS, SystemStatusPayload::error());

        if let Some(err) = kill_error {
            return Err(err);
        }
        Ok(())
    }

    pub fn kill_port_processes(&self) -> EngineResult<()> {
        kill_processes_on_port(self.current_api_port).map_err(EngineError::PortCleanupFailed)
    }
}
