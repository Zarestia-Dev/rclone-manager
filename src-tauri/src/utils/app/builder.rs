#[cfg(feature = "tray")]
pub async fn setup_tray(app: tauri::AppHandle) -> tauri::Result<()> {
    let app_clone = app.clone();
    use crate::core::settings::AppSettingsManager;
    use crate::core::tray::TraySnapshot;
    use crate::core::tray::menu::{MenuPlan, create_tray_menu_from_plan};
    use tauri::Manager;

    let snapshot = TraySnapshot::fetch(&app_clone).await?;

    // Build plan off main thread
    let plan = {
        let settings_manager = app_clone.state::<AppSettingsManager>();
        let max_tray_items = settings_manager
            .get_all()
            .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?
            .core
            .max_tray_items;
        MenuPlan::build(&snapshot, max_tray_items)
    };

    let tray_menu = create_tray_menu_from_plan(&app, &plan)?;
    let icon = crate::core::tray::icon::get_icon(false)
        .unwrap_or_else(|_| tauri::image::Image::new(&[], 0, 0));

    app.run_on_main_thread(move || {
        #[allow(unused_mut)]
        let mut tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
            .icon(icon)
            .tooltip(crate::t!("tray.tooltipDefault"))
            .menu(&tray_menu);

        #[cfg(not(feature = "web-server"))]
        {
            tray = tray.on_tray_icon_event(move |tray, event| {
                if let tauri::tray::TrayIconEvent::DoubleClick {
                    button: tauri::tray::MouseButton::Left,
                    ..
                } = event
                {
                    crate::core::tray::actions::show_main_window(tray.app_handle().clone());
                }
            });
        }

        if let Err(e) = tray.build(&app_clone) {
            log::error!("Failed to build tray icon: {e}");
        }
    })?;

    Ok(())
}

#[cfg(not(feature = "web-server"))]
fn apply_platform_config(
    builder: tauri::WebviewWindowBuilder<'_, tauri::Wry, tauri::AppHandle>,
) -> tauri::WebviewWindowBuilder<'_, tauri::Wry, tauri::AppHandle> {
    #[allow(unused_mut)]
    let mut b = builder
        .inner_size(800.0, 630.0)
        .resizable(true)
        .center()
        .shadow(false)
        .devtools(true)
        .min_inner_size(362.0, 240.0);

    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Visible);
    }

    #[cfg(target_os = "windows")]
    {
        use tauri::webview::ScrollBarStyle;
        b = b.scroll_bar_style(ScrollBarStyle::FluentOverlay);
    }

    #[cfg(not(target_os = "macos"))]
    {
        b = b.decorations(false).transparent(true);
    }

    b
}

#[cfg(not(feature = "web-server"))]
pub fn create_app_window(app_handle: tauri::AppHandle) {
    let builder =
        tauri::WebviewWindowBuilder::new(&app_handle, "main", tauri::WebviewUrl::default())
            .title("RClone Manager");

    let window = apply_platform_config(builder)
        .build()
        .expect("Failed to build main window");

    window
        .show()
        .unwrap_or_else(|e| log::error!("Failed to show main window: {e}"));

    #[cfg(target_os = "macos")]
    crate::utils::app::platform::update_macos_dock_visibility(&app_handle);
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowOptions {
    pub label: String,
    pub url: String,
    pub title: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub remote: Option<String>,
    pub path: Option<String>,
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn new_window(app_handle: tauri::AppHandle, opts: WindowOptions) -> bool {
    if let Some(existing) = tauri::Manager::get_webview_window(&app_handle, &opts.label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();

        // Special case: if this is a nautilus window, emit BROWSE event with the path
        if opts.label.starts_with("nautilus-") || opts.label == "nautilus" {
            let full_path = match (opts.remote, opts.path) {
                (Some(r), Some(p)) => {
                    let is_local = crate::rclone::state::cache::is_local_path(&r);
                    let sep = if is_local { "/" } else { ":" };
                    format!("{}{}{}", r, sep, p.trim_start_matches('/'))
                }
                (Some(r), None) => r,
                (None, Some(p)) => p,
                _ => String::new(),
            };
            use crate::utils::types::events::BROWSE;
            let _ = tauri::Emitter::emit(&existing, BROWSE, full_path);
        }
        return false;
    }

    let w = opts.width.unwrap_or(360.0);
    let h = opts.height.unwrap_or(240.0);

    let builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        &opts.label,
        tauri::WebviewUrl::App(opts.url.into()),
    )
    .title(&opts.title)
    .inner_size(w, h)
    .min_inner_size(360.0, 240.0);

    match apply_platform_config(builder).build() {
        Ok(window) => {
            let _ = window.show();
            #[cfg(target_os = "macos")]
            crate::utils::app::platform::update_macos_dock_visibility(&app_handle);
            true
        }
        Err(e) => {
            log::error!("Failed to build window {}: {e}", opts.label);
            false
        }
    }
}
