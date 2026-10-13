//! Native IPC adapters; shared commands use the same contract as HTTP.
use crate::context::BackendContext;
use tauri::Manager;
pub fn dispatch_invoke(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let command = invoke.message.command().to_owned();
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
