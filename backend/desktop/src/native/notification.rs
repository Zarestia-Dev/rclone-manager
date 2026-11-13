use crate::context::AppHandle;
use crate::services::alerts::template::TemplateContext;
use std::fmt::Display;

fn toast_failed(error: impl Display) -> String {
    rclone_manager_core::localized_error!("backendErrors.notification.toastFailed", "error" => error)
}

pub fn dispatch(_app: &AppHandle, ctx: &TemplateContext) -> Result<(), String> {
    let title = ctx.title.clone();
    let body = ctx.body.clone();
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(move || {
            notify_rust::Notification::new()
                .summary(&title)
                .body(&body)
                .show()
                .map(|_| ())
                .map_err(toast_failed)
        })
        .join()
        .map_err(|_| toast_failed("the notification thread panicked"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let app_clone = _app.clone();
        app_clone
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .icon("ic_notification")
            .auto_cancel()
            .show()
            .map_err(toast_failed)
    }
}
