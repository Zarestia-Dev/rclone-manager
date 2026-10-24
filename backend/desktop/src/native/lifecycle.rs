use crate::context::AppHandle;

pub(crate) fn restart(app: &AppHandle) -> Result<(), String> {
    app.restart();
}
