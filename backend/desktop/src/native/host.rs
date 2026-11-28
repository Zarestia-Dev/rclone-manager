use crate::context::AppHandle;
#[cfg(feature = "portable")]
use crate::desktop::paths::resolve_paths;
#[cfg(not(feature = "portable"))]
use crate::native::paths::resolve_paths;
use crate::services::updates::policy::InstallationKind;
use rclone_manager_core::context::{AppHandle as CoreHandle, ExitDecision, Host};
use tauri::utils::config::BundleType;
pub(crate) struct NativeHost(pub AppHandle);

/// What the build is, from what it can tell about itself. Tauri patches the bundle
/// it was packaged as into the binary; the other facts are arguments, so that every
/// case can be tested.
fn kind_of_build(
    portable: bool,
    bundle: Option<BundleType>,
    appimage_env: bool,
    in_app_bundle: bool,
) -> InstallationKind {
    if portable {
        return InstallationKind::Portable;
    }
    match bundle {
        Some(BundleType::Deb) => InstallationKind::Deb,
        Some(BundleType::Rpm) => InstallationKind::Rpm,
        Some(BundleType::Nsis) => InstallationKind::Nsis,
        Some(BundleType::Msi) => InstallationKind::Msi,
        // `$APPIMAGE` names the file that gets replaced, and child processes inherit
        // it: only a build packaged as an AppImage may trust it.
        Some(BundleType::AppImage) if appimage_env => InstallationKind::Appimage,
        // macOS reports an app for every binary: only one inside a bundle can be
        // replaced, not a build run from `target/`.
        Some(BundleType::App) if in_app_bundle => InstallationKind::MacApp,
        _ => InstallationKind::Unknown,
    }
}

#[async_trait::async_trait]
impl Host for NativeHost {
    fn installation_kind(&self) -> InstallationKind {
        kind_of_build(
            cfg!(feature = "portable"),
            tauri::utils::platform::bundle_type(),
            std::env::var_os("APPIMAGE").is_some(),
            // Resolved the way the installer resolves it.
            std::env::current_exe()
                .and_then(|exe| exe.canonicalize())
                .is_ok_and(|exe| crate::utils::app::paths::app_bundle_path(&exe).is_some()),
        )
    }
    fn resolve_paths(&self, _app: &CoreHandle) -> Result<crate::services::paths::AppPaths, String> {
        resolve_paths(&self.0)
    }
    fn restart(&self, _app: &CoreHandle) -> Result<(), String> {
        // Tauri's restart exits without `RunEvent::Exit`; the tray is not Tauri's.
        #[cfg(feature = "tray")]
        crate::services::tray::native::remove_before_exit(_app);
        self.0.restart()
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
            use tauri::Manager;
            let state = crate::services::tray::TrayMenuState::default();
            // `--tray` shows the tray even when the setting is off.
            let forced = self.0.state::<crate::cli::CliArgs>().start_in_tray();
            state
                .requested_visible
                .store(forced, std::sync::atomic::Ordering::SeqCst);
            _app.manage(state);
        }
        super::setup::prepare(&self.0, paths).map_err(|e| e.to_string())
    }
    fn init_theme(&self) {
        super::theme::init_system_theme();
    }
    fn monitor_theme(&self) {
        super::theme::monitor_theme_changes();
    }
    fn cleanup(&self) {
        super::files::cleanup_temp_views(&self.0);
    }
    fn confirm_exit(
        &self,
        _summary: crate::services::lifecycle::exit::ActiveOperationsSummary,
    ) -> ExitDecision {
        #[cfg(desktop)]
        {
            use crate::context::BackendContext;
            use tauri::{Emitter, Manager};
            let locked = crate::services::settings::access::is_locked(self.0.backend());
            // This native control event never reaches SSE.
            let summary = _summary.redacted(locked);
            if self.0.get_webview_window("main").is_none() {
                crate::services::lifecycle::exit::set_pending_app_exit_summary(
                    self.0.backend(),
                    summary.clone(),
                );
            }
            crate::desktop::window::present_main_window(&self.0);
            if locked {
                if let Err(error) = self.0.emit_to(
                    tauri::EventTarget::webview_window("main"),
                    crate::utils::types::events::APP_EXIT_REQUESTED,
                    summary,
                ) {
                    log::error!("Failed to request locked-window exit confirmation: {error}");
                }
            } else {
                crate::services::bridge::emit(
                    crate::utils::types::events::APP_EXIT_REQUESTED,
                    summary,
                );
            }
            ExitDecision::Deferred
        }
        #[cfg(mobile)]
        ExitDecision::Proceed
    }
    #[cfg(feature = "tray")]
    fn run_on_main_thread(&self, task: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        self.0.run_on_main_thread(task).map_err(|e| e.to_string())
    }
    #[cfg(feature = "tray")]
    fn open_view(&self, view: crate::services::tray::actions::TrayView<'_>) {
        use crate::services::tray::actions::TrayView;
        match view {
            TrayView::Main => crate::desktop::window::present_main_window(&self.0),
            TrayView::FileBrowser(remote) => {
                log::info!("Tray: opening in-app browser for {remote:?}");
                let (app, options) = (
                    self.0.clone(),
                    crate::desktop::window::nautilus_window(remote),
                );
                crate::utils::spawn(async move {
                    crate::desktop::window::new_window(app, options).await;
                });
            }
        }
    }
    #[cfg(feature = "tray")]
    fn open_folder(&self, path: &std::path::Path) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.0
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    }
    /// The Windows taskbar follows the Windows mode, not the app mode the window
    /// uses, so the tray reads it there (one registry read per rebuild).
    #[cfg(feature = "tray")]
    fn is_system_dark(&self) -> bool {
        #[cfg(windows)]
        if let Some(dark) = crate::utils::app::system_theme::detect_panel() {
            return dark;
        }
        super::theme::is_system_dark()
    }
    #[cfg(any(autostart_plugin, autostart_portal))]
    fn set_autostart(&self, enabled: bool) {
        crate::desktop::autostart::handle_autostart_change(&self.0, enabled);
    }
    #[cfg(autostart_plugin)]
    fn sync_autostart(&self) {
        crate::desktop::autostart::restore_missing_autostart(&self.0);
    }
    #[cfg(feature = "tauri-plugin-notification")]
    fn notify(
        &self,
        ctx: &crate::services::alerts::template::TemplateContext,
    ) -> Result<(), String> {
        super::notification::dispatch(&self.0, ctx)
    }
}

#[cfg(test)]
mod kind_tests {
    use super::*;

    #[test]
    fn a_build_is_what_it_was_packaged_as() {
        for (bundle, kind) in [
            (BundleType::Deb, InstallationKind::Deb),
            (BundleType::Rpm, InstallationKind::Rpm),
            (BundleType::Nsis, InstallationKind::Nsis),
            (BundleType::Msi, InstallationKind::Msi),
        ] {
            // `$APPIMAGE` and the app bundle only matter to their own kinds.
            for (appimage, in_app) in [(false, false), (true, true)] {
                assert_eq!(
                    kind_of_build(false, Some(bundle.clone()), appimage, in_app),
                    kind
                );
            }
        }
    }

    #[test]
    fn an_appimage_needs_the_variable_that_names_its_file() {
        let appimage = |env| kind_of_build(false, Some(BundleType::AppImage), env, false);
        assert_eq!(appimage(true), InstallationKind::Appimage);
        // An extracted AppImage, or a build that inherited another app's variable.
        assert_eq!(appimage(false), InstallationKind::Unknown);
    }

    #[test]
    fn a_mac_app_must_sit_in_a_bundle() {
        let app = |in_bundle| kind_of_build(false, Some(BundleType::App), false, in_bundle);
        assert_eq!(app(true), InstallationKind::MacApp);
        assert_eq!(app(false), InstallationKind::Unknown);
    }

    #[test]
    fn a_portable_build_is_portable_whatever_it_says_it_is() {
        assert_eq!(
            kind_of_build(true, Some(BundleType::App), false, true),
            InstallationKind::Portable
        );
        assert_eq!(
            kind_of_build(true, None, false, false),
            InstallationKind::Portable
        );
    }

    #[test]
    fn an_unpackaged_build_is_unknown() {
        for appimage in [false, true] {
            assert_eq!(
                kind_of_build(false, None, appimage, false),
                InstallationKind::Unknown
            );
        }
        assert_eq!(
            kind_of_build(false, Some(BundleType::Dmg), false, true),
            InstallationKind::Unknown
        );
    }
}
