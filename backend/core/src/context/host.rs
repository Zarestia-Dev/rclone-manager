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
    /// What this build is, so that it can replace itself: the server says `Server`,
    /// the desktop app what it was packaged as. A host that does not say is
    /// `Unknown`, and no update is installed for it.
    fn installation_kind(&self) -> crate::services::updates::policy::InstallationKind {
        crate::services::updates::policy::InstallationKind::Unknown
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
