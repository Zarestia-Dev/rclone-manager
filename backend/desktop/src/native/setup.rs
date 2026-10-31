//! Native host setup hooks, called by the application composition root.
use crate::context::AppHandle;

pub(crate) fn prepare(
    _app: &AppHandle,
    _app_paths: &crate::services::paths::AppPaths,
) -> Result<(), Box<dyn std::error::Error>> {
    // Clean up temporary file preview/viewer cache from previous sessions
    #[cfg(not(feature = "web-server"))]
    crate::native::files::cleanup_temp_views(_app);

    #[cfg(target_os = "ios")]
    {
        log::debug!("Creating main window on mobile");
        tauri::WebviewWindowBuilder::new(_app, "main", tauri::WebviewUrl::default()).build()?;
    }

    Ok(())
}

pub(crate) fn start(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(all(
        feature = "tauri-plugin-deep-link",
        any(
            all(
                target_os = "linux",
                not(feature = "flatpak"),
                not(feature = "web-server")
            ),
            all(debug_assertions, windows)
        )
    ))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        _app.deep_link().register_all()?;
    }

    Ok(())
}

pub(crate) fn present(_app: &AppHandle, _cli_args: &crate::cli::CliArgs) {
    #[cfg(all(desktop, not(feature = "web-server")))]
    if super::window::should_open_main_window(_cli_args) {
        log::debug!("Creating main window");
        crate::desktop::window::create_app_window(_app.clone());
    }
}

pub(crate) fn finish(_app: &AppHandle) {
    #[cfg(target_os = "macos")]
    crate::native::dock::update_macos_dock_visibility(_app);
}
