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
    /// The Linux package format a Tauri build was bundled as (DEB, RPM or AppImage).
    fn native_bundle(&self) -> Option<crate::services::updates::policy::InstallationKind> {
        None
    }
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
        _summary: crate::services::lifecycle::exit::ActiveOperationsSummary,
    ) -> ExitDecision {
        ExitDecision::Proceed
    }
    /// Runs `task` on the thread that owns the UI event loop, where native tray
    /// objects must be created and changed.
    #[cfg(feature = "tray")]
    fn run_on_main_thread(&self, _task: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        Err("This host has no UI thread".into())
    }
    /// Opens the part of the interface a tray entry points to.
    #[cfg(feature = "tray")]
    fn open_view(&self, _view: crate::services::tray::actions::TrayView<'_>) {}
    /// Opens a local folder, such as a mount point, in the file manager.
    #[cfg(feature = "tray")]
    fn open_folder(&self, _path: &std::path::Path) -> Result<(), String> {
        Err("Opening folders is unavailable".into())
    }
    /// Whether the system uses a dark theme, for a tray icon that follows it.
    #[cfg(feature = "tray")]
    fn is_system_dark(&self) -> bool {
        false
    }
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
    /// The native update for `expected_version` in `release`, if the host has one.
    #[cfg(feature = "updater")]
    async fn check_update(
        &self,
        _release: &crate::utils::github_client::Release,
        _expected_version: &str,
    ) -> Result<crate::utils::types::updater::ReleaseArtifact, String> {
        Ok(crate::utils::types::updater::ReleaseArtifact::Unpublished)
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
