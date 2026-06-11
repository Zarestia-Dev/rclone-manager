use log::{error, info};
use tauri::{AppHandle, Emitter, Manager};

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
        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();
        let backend = backend_manager.get_active().await;

        self.current_api_port = backend.port;

        let engine_cmd = match build_rclone_process_command(app, ProcessKind::Engine).await {
            Ok(cmd) => cmd,
            Err(e) => {
                error!("Failed to create engine command: {e}");
                if let EngineError::PasswordRequired = e {
                    self.set_password_error(true);
                }
                return Err(e);
            }
        };

        match engine_cmd.spawn() {
            Ok(child) => {
                info!("Rclone process spawned");
                self.set_path_error(false);
                Ok(child)
            }
            Err(e) => {
                error!("Failed to spawn rclone process: {e}");
                let err_text = e.to_string();
                let is_path_error = err_text.contains("No such file or directory")
                    || err_text.contains("os error 2");
                self.set_path_error(is_path_error);

                if is_path_error {
                    Err(EngineError::InvalidPath)
                } else {
                    Err(EngineError::SpawnFailed(err_text))
                }
            }
        }
    }

    pub async fn kill_process(&mut self, app: &AppHandle) -> EngineResult<()> {
        let Some(mut child) = self.process.take() else {
            self.running = false;
            return Ok(());
        };

        use crate::core::settings::AppSettingsManager;
        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();
        let backend = backend_manager.get_active().await;

        if self.running && child.id().is_some() {
            let state = app.state::<RcloneState>();
            let quit_request = backend.inject_auth(state.client.post(backend.url_for(core::QUIT)));

            if graceful_shutdown(child, quit_request).await.is_ok() {
                self.running = false;
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
                return Ok(());
            }
        } else {
            info!("Force killing engine process");
            if let Err(e) = child.kill().await {
                let msg = format!("Failed to kill process: {e}");
                error!("{msg}");
                return Err(EngineError::KillFailed(msg));
            }
            let _ = child.wait().await;
        }

        self.running = false;
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
        Ok(())
    }

    pub fn kill_port_processes(&self) -> EngineResult<()> {
        kill_processes_on_port(self.current_api_port).map_err(EngineError::PortCleanupFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::engine::core::DEFAULT_API_PORT;

    #[tokio::test]
    async fn test_kill_process_no_process() {
        let engine = RcApiEngine {
            running: false,
            ..Default::default()
        };
        assert!(!engine.running);
    }

    #[tokio::test]
    async fn test_kill_port_processes_default_port() {
        let engine = RcApiEngine::default();
        assert_eq!(engine.current_api_port, DEFAULT_API_PORT);
        let _ = engine.kill_port_processes();
    }
}
