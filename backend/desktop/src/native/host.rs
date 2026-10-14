use crate::context::AppHandle;
use rclone_manager_core::context::{AppHandle as CoreHandle, ExitDecision, Host};
pub(crate) struct NativeHost(pub AppHandle);
#[async_trait::async_trait]
impl Host for NativeHost {
    fn resolve_paths(&self, _app: &CoreHandle) -> Result<crate::services::paths::AppPaths, String> {
        #[cfg(feature = "portable")]
        {
            crate::desktop::paths::resolve_paths(&self.0)
        }
        #[cfg(not(feature = "portable"))]
        {
            super::paths::resolve_paths(&self.0)
        }
    }
    fn restart(&self, _app: &CoreHandle) -> Result<(), String> {
        super::lifecycle::restart(&self.0)
    }
    fn exit(&self, code: i32) {
        self.0.exit(code);
    }
    #[cfg(all(target_os = "windows", feature = "desktop"))]
    fn main_window_hwnd(&self) -> Option<isize> {
        use tauri::Manager;
        self.0
            .get_webview_window("main")
            .and_then(|window| window.hwnd().ok())
            .map(|hwnd| hwnd.0 as isize)
    }
    fn prepare(
        &self,
        _app: &CoreHandle,
        paths: &crate::services::paths::AppPaths,
    ) -> Result<(), String> {
        #[cfg(feature = "tray")]
        {
            _app.manage(crate::desktop::tray::TrayMenuState::default());
        }
        super::setup::prepare(&self.0, paths).map_err(|e| e.to_string())
    }
    fn init_theme(&self) {
        #[cfg(not(feature = "web-server"))]
        super::theme::init_system_theme();
    }
    fn monitor_theme(&self) {
        #[cfg(not(feature = "web-server"))]
        super::theme::monitor_theme_changes();
    }
    fn cleanup(&self) {
        #[cfg(not(feature = "web-server"))]
        super::files::cleanup_temp_views(&self.0);
    }
    fn confirm_exit(
        &self,
        _summary: crate::utils::app::platform::ActiveOperationsSummary,
    ) -> ExitDecision {
        #[cfg(all(desktop, not(feature = "web-server")))]
        {
            use tauri::Manager;
            if self.0.get_webview_window("main").is_none() {
                crate::utils::app::platform::set_pending_app_exit_summary(_summary.clone());
            }
            crate::desktop::window::present_main_window(&self.0);
            crate::services::bridge::emit(
                crate::utils::types::events::APP_EXIT_REQUESTED,
                _summary,
            );
            ExitDecision::Deferred
        }
        #[cfg(any(mobile, feature = "web-server"))]
        ExitDecision::Proceed
    }
    #[cfg(feature = "tray")]
    async fn setup_tray(&self) -> Result<(), String> {
        use crate::context::BackendContext;
        use tauri::Manager;
        let args = self.0.state::<crate::cli::CliArgs>();
        let manager = self
            .0
            .backend_state::<crate::services::settings::AppSettingsManager>();
        let settings = manager.get_all().map_err(|e| e.to_string())?;
        if !settings.general.tray_enabled && !args.tray {
            return Ok(());
        }
        crate::desktop::tray::setup::setup_tray(self.0.clone())
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(feature = "tray")]
    fn update_tray(&self) {
        crate::desktop::tray::events::trigger_tray_update(self.0.clone());
    }
    #[cfg(feature = "tray")]
    fn set_tray_visible(&self, enabled: bool) {
        crate::desktop::tray::events::handle_tray_visibility_change(&self.0, enabled);
    }
    #[cfg(any(feature = "tauri-plugin-autostart", feature = "flatpak"))]
    fn set_autostart(&self, enabled: bool) {
        #[cfg(all(target_os = "linux", feature = "flatpak"))]
        crate::desktop::autostart::handle_autostart_change(enabled);
        #[cfg(not(all(target_os = "linux", feature = "flatpak")))]
        crate::desktop::autostart::handle_autostart_change(&self.0, enabled);
    }
    #[cfg(feature = "tauri-plugin-notification")]
    fn notify(
        &self,
        ctx: &crate::services::alerts::template::TemplateContext,
    ) -> Result<(), String> {
        super::notification::dispatch(&self.0, ctx)
    }
    #[cfg(feature = "updater")]
    async fn check_update(
        &self,
        release: &crate::utils::github_client::Release,
        metadata: &mut crate::utils::types::updater::UpdateMetadata,
    ) -> Option<crate::utils::types::updater::PendingAppUpdate> {
        super::updater::check_native_updater(&self.0, release, metadata).await
    }
}
