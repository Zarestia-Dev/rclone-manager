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
    fn update_method(&self) -> crate::services::updates::policy::UpdateMethod {
        crate::services::updates::policy::UpdateMethod::Unavailable
    }
    fn is_portable_installation(&self) -> bool {
        false
    }
    fn resolve_paths(&self, app: &AppHandle) -> Result<AppPaths, String>;
    fn restart(&self, app: &AppHandle) -> Result<(), String>;
    #[cfg(all(feature = "updater", unix))]
    fn restart_updated_binary(
        &self,
        executable: &std::path::Path,
        previous: &std::path::Path,
        arguments: &[std::ffi::OsString],
        working_directory: &std::path::Path,
    ) -> Result<(), String> {
        crate::services::updates::binary::restart(
            executable,
            previous,
            arguments,
            working_directory,
        )
    }
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
        _summary: crate::services::lifecycle::exit::ActiveOperationsSummary,
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
    /// Re-register the OS autostart entry when the setting is on but the entry is gone,
    /// e.g. after an uninstall removed it.
    #[cfg(any(feature = "autostart", feature = "flatpak"))]
    fn sync_autostart(&self) {}
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
    ) -> Result<Option<crate::utils::types::updater::PendingAppUpdate>, String> {
        Ok(None)
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
