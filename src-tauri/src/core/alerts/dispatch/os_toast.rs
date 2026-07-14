use crate::core::alerts::template::TemplateContext;
use tauri::AppHandle;

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
                .map_err(|e| format!("OS toast failed: {e}"))
        })
        .join()
        .map_err(|_| "OS toast thread panicked".to_string())?
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
            .auto_cancel()
            .show()
            .map_err(|e| format!("OS toast failed: {e}"))
    }
}
