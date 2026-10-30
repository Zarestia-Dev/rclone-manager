use crate::context::AppHandle;
use log::{error, info};

use crate::rclone::backend::{BackendManager, types::Backend};
use crate::rclone::binaries::process_common::build_rclone_process_command;
use crate::rclone::binaries::process_common::graceful_shutdown;
use crate::rclone::endpoints::core;
use crate::utils::process::process_manager::kill_processes_on_port;
use crate::utils::types::events::SYSTEM_STATUS;
use crate::utils::types::monitoring::SystemStatusPayload;
use crate::utils::types::state::{RcApiEngine, RcloneState};

use super::error::{EngineError, EngineResult};

impl RcApiEngine {
    pub async fn spawn_process(&mut self, app: &AppHandle) -> EngineResult<tokio::process::Child> {
        let backend_manager = app.state::<BackendManager>();
        let backend = backend_manager.get_active().await;

        self.current_api_port = backend.port;

        let engine_cmd = match build_rclone_process_command(app).await {
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
                self.process_backend = Some(backend.name.clone());
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

    /// The backend the tracked child was spawned for. Without a tracked child this is the
    /// active backend, which is where a stale daemon on the local port would belong.
    async fn process_owner(&mut self, manager: &BackendManager) -> Backend {
        if let Some(name) = self.process_backend.take()
            && let Some(backend) = manager.get(&name).await
        {
            return backend;
        }
        manager.get_active().await
    }

    pub async fn kill_process(&mut self, app: &AppHandle) -> EngineResult<()> {
        let backend_manager = app.state::<BackendManager>();
        let backend = self.process_owner(&backend_manager).await;

        if let Some(child) = self.process.take() {
            if child.id().is_some() {
                let state = app.state::<RcloneState>();
                let quit_request =
                    backend.inject_auth(state.client.post(backend.url_for(core::QUIT)));

                if let Err(e) = graceful_shutdown(child, quit_request).await {
                    log::warn!("Graceful shutdown failed: {e}");
                }
            } else {
                log::debug!("Engine process had already terminated");
            }
        }

        if backend.is_local {
            // Enumerating sockets and the settle pause would otherwise stall an async worker.
            let port = backend.port;
            let _ = crate::utils::spawn_blocking(move || kill_processes_on_port(port)).await;
        }

        self.mark_stopped();

        if backend.is_auth_generated {
            let mut updated_backend = backend.clone();
            updated_backend.username = None;
            updated_backend.password = None;
            updated_backend.is_auth_generated = false;
            let _ = backend_manager.update(&backend.name, updated_backend).await;
        }

        crate::services::bridge::emit(SYSTEM_STATUS, SystemStatusPayload::inactive());

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::CopySources;
    use crate::services::settings::AppSettingsManager;
    use crate::utils::constants::LOCAL_BACKEND_NAME;

    fn settings() -> (tempfile::TempDir, AppSettingsManager) {
        let directory = tempfile::tempdir().unwrap();
        let mut builder = rcman::SettingsManager::builder("process-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>();
        for name in crate::utils::constants::ENGINE_SUB_SETTINGS {
            builder = builder
                .with_sub_settings(rcman::SubSettingsConfig::singlefile(name).with_profiles());
        }
        (directory, builder.build().unwrap())
    }

    async fn manager_with_active_remote() -> (tempfile::TempDir, BackendManager) {
        let (directory, settings) = settings();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("NAS", "10.0.0.2", 5572),
                CopySources::default(),
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "NAS").await.unwrap();
        (directory, manager)
    }

    #[tokio::test]
    async fn the_child_is_stopped_through_the_backend_it_was_spawned_for() {
        let (_directory, manager) = manager_with_active_remote().await;
        let mut engine = RcApiEngine::default();
        engine.process_backend = Some(LOCAL_BACKEND_NAME.to_string());

        let owner = engine.process_owner(&manager).await;

        assert_eq!(owner.name, LOCAL_BACKEND_NAME);
        assert!(engine.process_backend.is_none());
    }

    #[tokio::test]
    async fn without_a_tracked_child_the_active_backend_is_addressed() {
        let (_directory, manager) = manager_with_active_remote().await;
        let mut engine = RcApiEngine::default();

        assert_eq!(engine.process_owner(&manager).await.name, "NAS");

        engine.process_backend = Some("removed".to_string());
        assert_eq!(engine.process_owner(&manager).await.name, "NAS");
    }
}
