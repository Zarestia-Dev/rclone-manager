use crate::core::alerts::{template::TemplateContext, types::OsToastAction};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub fn dispatch(
    app: &AppHandle,
    _action: &OsToastAction,
    ctx: &TemplateContext,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&ctx.title)
        .body(&ctx.body)
        .auto_cancel()
        .show()
        .map_err(|e| format!("OS toast failed: {e}"))
}
