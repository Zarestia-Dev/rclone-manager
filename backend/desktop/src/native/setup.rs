//! Native host setup hooks, called by the application composition root.
use crate::context::AppHandle;

pub(crate) fn prepare(
    _app: &AppHandle,
    _app_paths: &crate::services::paths::AppPaths,
) -> Result<(), Box<dyn std::error::Error>> {
    // Clean up temporary file preview/viewer cache from previous sessions
    #[cfg(not(feature = "web-server"))]
    crate::native::files::remove_temp_views(&_app_paths.cache_dir);

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
        // Best effort: registering the URL scheme runs the host's update-desktop-database and
        // xdg-mime, which can fail (e.g. the AppImage's bundled glib shadows the host's, #342).
        // Deep links are optional, so a failure must not stop the app from starting.
        if let Err(error) = _app.deep_link().register_all() {
            log::warn!("Could not register the deep-link scheme: {error}");
        }
    }

    Ok(())
}

pub(crate) fn present(_app: &AppHandle, _cli_args: &crate::cli::CliArgs) {
    #[cfg(all(desktop, not(feature = "web-server")))]
    if super::window::should_open_main_window(
        _cli_args,
        crate::services::settings::access::is_locked(crate::context::BackendContext::backend(_app)),
    ) {
        log::debug!("Creating main window");
        crate::desktop::window::create_app_window(_app).expect("Failed to build main window");
    }
}

pub(crate) fn finish(_app: &AppHandle) {
    #[cfg(target_os = "macos")]
    crate::native::dock::update_macos_dock_visibility(_app);
}
