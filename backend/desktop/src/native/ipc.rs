//! Native IPC adapters; shared commands use the same contract as HTTP.
use crate::context::BackendContext;
use tauri::Manager;
// Local desktop lifecycle controls remain available while the vault is locked.
// HTTP still goes through the shared dispatcher and its unchanged access boundary.
#[cfg(all(desktop, not(feature = "web-server")))]
#[derive(Debug, PartialEq)]
enum NativeLifecycleCommand {
    Request,
    Confirm,
    Pending,
}

#[cfg(all(desktop, not(feature = "web-server")))]
impl NativeLifecycleCommand {
    fn parse(command: &str) -> Option<Self> {
        match command {
            "request_app_exit" => Some(Self::Request),
            "shutdown_app" => Some(Self::Confirm),
            "check_pending_app_exit" => Some(Self::Pending),
            _ => None,
        }
    }

    async fn execute(
        self,
        app: rclone_manager_core::context::AppHandle,
    ) -> Result<serde_json::Value, String> {
        match self {
            Self::Request => crate::services::lifecycle::exit::request_app_exit(app).await?,
            Self::Confirm => crate::services::lifecycle::shutdown::shutdown_app(app).await?,
            Self::Pending => {
                let summary = crate::services::lifecycle::exit::check_pending_app_exit(app.clone())
                    .map(|summary| {
                        super::host::exit_notice_summary(
                            summary,
                            crate::services::settings::access::is_locked(&app),
                        )
                    });
                return serde_json::to_value(summary).map_err(|error| error.to_string());
            }
        }
        Ok(serde_json::Value::Null)
    }
}

pub fn dispatch_invoke(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let command = invoke.message.command().to_owned();
    #[cfg(all(desktop, not(feature = "web-server")))]
    if let Some(command) = NativeLifecycleCommand::parse(&command) {
        if command == NativeLifecycleCommand::Pending
            && invoke.message.webview_ref().label() != "main"
        {
            invoke.resolver.resolve(serde_json::Value::Null);
            return true;
        }
        let app = invoke.message.webview_ref().app_handle().backend().clone();
        invoke
            .resolver
            .respond_async(async move { command.execute(app).await.map_err(Into::into) });
        return true;
    }
    if rclone_manager_core::app::dispatch::is_command(&command) {
        let app = invoke.message.webview_ref().app_handle().backend().clone();
        match invoke.message.payload() {
            tauri::ipc::InvokeBody::Json(payload) => {
                let payload = payload.clone();
                invoke.resolver.respond_async(async move {
                    rclone_manager_core::app::dispatch::bridge_dispatch(&app, &command, payload)
                        .await
                        .map_err(Into::into)
                });
            }
            tauri::ipc::InvokeBody::Raw(_) => {
                invoke.resolver.reject("Expected JSON command arguments")
            }
        }
        return true;
    }
    if rclone_manager_core::services::settings::access::is_locked(
        invoke.message.webview_ref().app_handle().backend(),
    ) {
        invoke
            .resolver
            .reject(rclone_manager_core::services::settings::access::locked_error());
        return true;
    }
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        #[cfg(not(feature = "web-server"))]
        crate::native::files::open_in_files,
        #[cfg(not(feature = "web-server"))]
        crate::native::files::open_file_natively,
        #[cfg(all(desktop, not(feature = "web-server")))]
        crate::native::files::get_folder_location,
        #[cfg(not(feature = "web-server"))]
        crate::native::files::get_file_location,
        #[cfg(not(feature = "web-server"))]
        crate::native::files::get_files_location,
        #[cfg(not(feature = "web-server"))]
        crate::native::files::get_save_file_location,
        #[cfg(not(feature = "web-server"))]
        crate::native::files::download_file,
        #[cfg(not(feature = "web-server"))]
        crate::native::theme::set_theme,
        #[cfg(all(
            not(feature = "web-server"),
            not(target_os = "android"),
            not(target_os = "ios")
        ))]
        crate::desktop::debug::open_devtools,
        #[cfg(all(desktop, not(feature = "web-server")))]
        crate::desktop::window::new_window,
    ];
    handler(invoke)
}

#[cfg(all(test, desktop, not(feature = "web-server")))]
mod tests {
    use super::NativeLifecycleCommand;

    #[tokio::test]
    async fn pending_exit_counts_are_redacted_if_the_vault_locked_after_the_request() {
        use crate::services::lifecycle::exit::{
            ActiveOperationsSummary, set_pending_app_exit_summary,
        };
        use crate::services::settings::access::VaultAccess;
        use std::sync::Arc;

        let directory = tempfile::tempdir().unwrap();
        let manager = rcman::SettingsManager::builder("native-vault-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .build()
            .unwrap();
        let access = Arc::new(VaultAccess::new(directory.path(), &manager).unwrap());
        let app = rclone_manager_core::context::AppHandle::default();
        app.manage(manager);
        app.manage(access.clone());
        set_pending_app_exit_summary(
            &app,
            ActiveOperationsSummary {
                has_active_operations: true,
                active_jobs_count: 2,
                active_mounts_count: 3,
                active_serves_count: 4,
            },
        );
        access.lock();

        let notice = NativeLifecycleCommand::Pending
            .execute(app.clone())
            .await
            .unwrap();
        assert_eq!(
            notice,
            serde_json::json!({
                "hasActiveOperations": true,
                "activeJobsCount": 0,
                "activeMountsCount": 0,
                "activeServesCount": 0,
            })
        );
        assert_eq!(
            NativeLifecycleCommand::Pending.execute(app).await.unwrap(),
            serde_json::Value::Null
        );
    }

    #[test]
    fn only_local_exit_controls_bypass_the_vault_command_gate() {
        assert_eq!(
            NativeLifecycleCommand::parse("request_app_exit"),
            Some(NativeLifecycleCommand::Request)
        );
        assert_eq!(
            NativeLifecycleCommand::parse("shutdown_app"),
            Some(NativeLifecycleCommand::Confirm)
        );
        assert_eq!(
            NativeLifecycleCommand::parse("check_pending_app_exit"),
            Some(NativeLifecycleCommand::Pending)
        );
        for command in [
            "load_settings",
            "get_logs",
            "relaunch_app",
            "unlock_vault",
            "",
            "request_app_exit_extra",
        ] {
            assert_eq!(NativeLifecycleCommand::parse(command), None);
        }
    }
}
