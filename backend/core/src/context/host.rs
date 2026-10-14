use super::AppHandle;
use crate::services::paths::AppPaths;

/// Whether a requested exit can continue or awaits user interaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitDecision {
    /// Continue with shared cleanup and process exit.
    Proceed,
    /// The host has requested confirmation; do not shut down yet.
    Deferred,
}

/// OS capabilities supplied by the executable. The shared crate never imports a host.
#[async_trait::async_trait]
pub trait Host: Send + Sync {
    fn resolve_paths(&self, app: &AppHandle) -> Result<AppPaths, String>;
    fn restart(&self, app: &AppHandle) -> Result<(), String>;
    fn exit(&self, _code: i32) {}
    /// Main window HWND, if this host has a native Windows window.
    #[cfg(all(target_os = "windows", feature = "desktop"))]
    fn main_window_hwnd(&self) -> Option<isize> {
        None
    }
    fn prepare(&self, _app: &AppHandle, _paths: &AppPaths) -> Result<(), String> {
        Ok(())
    }
    fn init_theme(&self) {}
    fn monitor_theme(&self) {}
    fn cleanup(&self) {}
    fn confirm_exit(
        &self,
        _summary: crate::utils::app::platform::ActiveOperationsSummary,
    ) -> ExitDecision {
        ExitDecision::Proceed
    }
    #[cfg(feature = "tray")]
    async fn setup_tray(&self) -> Result<(), String> {
        Ok(())
    }
    #[cfg(feature = "tray")]
    fn update_tray(&self) {}
    #[cfg(feature = "tray")]
    fn set_tray_visible(&self, _enabled: bool) {}
    #[cfg(any(feature = "autostart", feature = "flatpak"))]
    fn set_autostart(&self, _enabled: bool) {}
    #[cfg(feature = "notifications")]
    fn notify(
        &self,
        _ctx: &crate::services::alerts::template::TemplateContext,
    ) -> Result<(), String> {
        Err("Native notifications are unavailable".into())
    }
    #[cfg(feature = "updater")]
    async fn check_update(
        &self,
        _release: &crate::utils::github_client::Release,
        _metadata: &mut crate::utils::types::updater::UpdateMetadata,
    ) -> Option<crate::utils::types::updater::PendingAppUpdate> {
        None
    }
}

struct UnconfiguredHost;
#[async_trait::async_trait]
impl Host for UnconfiguredHost {
    fn resolve_paths(&self, _app: &AppHandle) -> Result<AppPaths, String> {
        Err("Application host is not configured".into())
    }
    fn restart(&self, _app: &AppHandle) -> Result<(), String> {
        Err("Application host is not configured".into())
    }
}
pub(super) fn unconfigured() -> std::sync::Arc<dyn Host> {
    std::sync::Arc::new(UnconfiguredHost)
}
