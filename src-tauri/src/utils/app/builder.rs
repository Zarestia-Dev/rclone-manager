#![cfg(desktop)]

#[cfg(feature = "tray")]
pub async fn setup_tray(app: tauri::AppHandle) -> tauri::Result<()> {
    let app_clone = app.clone();
    use crate::core::tray::TraySnapshot;
    let snapshot = TraySnapshot::fetch(&app_clone).await?;
    let tray_menu = crate::core::tray::menu::create_tray_menu(&app_clone, &snapshot)?;

    #[allow(unused_mut)]
    let mut tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
        .icon(crate::core::tray::icon::get_icon(false)?)
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

    tray.build(&app_clone)?;
    tauri::Emitter::emit(&app, crate::utils::types::events::UPDATE_TRAY_MENU, ())?;
    Ok(())
}

#[cfg(not(feature = "web-server"))]
fn build_nautilus_url(remote_name: Option<&str>, path: Option<&str>) -> String {
    let Some(name) = remote_name else {
        return "nautilus".to_string();
    };

    let encoded_remote = urlencoding::encode(name);

    match path.filter(|p| !p.is_empty()) {
        Some(p) => {
            let clean_path = p.trim_start_matches('/');
            let encoded_path = urlencoding::encode(clean_path);
            format!("nautilus/{encoded_remote}/{encoded_path}")
        }
        None => format!("nautilus/{encoded_remote}"),
    }
}

#[cfg(not(feature = "web-server"))]
fn apply_platform_config<'a>(
    builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
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
        b = b
            .scroll_bar_style(ScrollBarStyle::FluentOverlay)
            .disable_drag_drop_handler();
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
}

#[cfg(not(feature = "web-server"))]
pub fn create_nautilus_window(
    app_handle: tauri::AppHandle,
    remote_name: Option<&str>,
    path: Option<&str>,
) {
    // Deterministic label based on remote identity
    let label = remote_name
        .map(|name| {
            let slug: String = name
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            format!("nautilus-{slug}")
        })
        .unwrap_or_else(|| "nautilus".to_string());

    if let Some(existing) = tauri::Manager::get_webview_window(&app_handle, &label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();

        use crate::utils::types::events::BROWSE;
        let full_path = match (remote_name, path) {
            (Some(r), Some(p)) => {
                let is_local = r.starts_with('/') || (r.len() > 1 && r.as_bytes()[1] == b':');
                let sep = if is_local { "/" } else { ":" };
                format!("{}{}{}", r, sep, p.trim_start_matches('/'))
            }
            (Some(r), None) => r.to_string(),
            (None, Some(p)) => p.to_string(),
            _ => "".to_string(),
        };
        let _ = tauri::Emitter::emit(&existing, BROWSE, full_path);
        return;
    }

    // Otherwise create a fresh window as before
    let url = build_nautilus_url(remote_name, path);
    let builder =
        tauri::WebviewWindowBuilder::new(&app_handle, label, tauri::WebviewUrl::App(url.into()))
            .title("RClone Nautilus");

    match apply_platform_config(builder).build() {
        Ok(window) => {
            window
                .show()
                .unwrap_or_else(|e| log::error!("Failed to show nautilus window: {e}"));
        }
        Err(e) => log::error!("Failed to build nautilus window: {e}"),
    }
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub fn new_nautilus_window(
    app_handle: tauri::AppHandle,
    remote: Option<String>,
    path: Option<String>,
) {
    create_nautilus_window(app_handle, remote.as_deref(), path.as_deref());
}
