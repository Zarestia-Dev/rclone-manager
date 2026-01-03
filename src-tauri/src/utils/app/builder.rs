#![cfg(desktop)]

use tauri::{
    AppHandle, Emitter,
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::core::tray::{actions::show_main_window, menu::create_tray_menu};
use crate::utils::types::events::UPDATE_TRAY_MENU;

pub async fn setup_tray(app: AppHandle, max_tray_items: usize) -> tauri::Result<()> {
    let mut old_max_tray_items = 0;

    let max_tray_items = if max_tray_items == 0 {
        old_max_tray_items
    } else {
        old_max_tray_items = max_tray_items;
        old_max_tray_items
    };

    let app_clone = app.clone();

    let tray_menu = create_tray_menu(&app_clone, max_tray_items).await?;

    TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(include_bytes!(
            "../../../icons/rclone_symbolic.png"
        ))?)
        .tooltip("RClone Manager")
        .menu(&tray_menu)
        .on_tray_icon_event(move |tray, event| {
            let app = tray.app_handle();

            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Show the main window on left click
                show_main_window(app.clone());
            }
        })
        .build(&app_clone)?;

    app.emit(UPDATE_TRAY_MENU, ())?;
    Ok(())
}

/// Creates the main app window.
/// Optionally accepts a remote name to navigate to the in-app browser for that remote.
pub fn create_app_window(app_handle: AppHandle, browse_remote: Option<&str>) {
    let mut main_window =
        tauri::WebviewWindowBuilder::new(&app_handle, "main", tauri::WebviewUrl::default())
            .title("RClone Manager")
            .inner_size(800.0, 630.0)
            .resizable(true)
            .center()
            .shadow(false)
            .devtools(true)
            .min_inner_size(362.0, 240.0);

    // MacOS does not support transparent windows. So we set the title bar style to show
    // and remove the decorations.
    // On other platforms, we set the decorations to false and make the window transparent.
    #[cfg(target_os = "macos")]
    {
        main_window = main_window.title_bar_style(tauri::TitleBarStyle::Visible);
    }

    // Windows specific scroll bar style
    // Set to FluentOverlay for better appearance and not pushing content
    #[cfg(target_os = "windows")]
    {
        use tauri::webview::ScrollBarStyle;
        main_window = main_window.scroll_bar_style(ScrollBarStyle::FluentOverlay);
    }

    #[cfg(not(target_os = "macos"))]
    {
        main_window = main_window.decorations(false).transparent(true);
    }

    let main_window = main_window.build().expect("Failed to build main window");

    // Navigate to current URL with browse parameter if provided
    if let Some(remote_name) = browse_remote {
        let remote_encoded = urlencoding::encode(remote_name);
        if let Ok(current_url) = main_window.url() {
            let new_url = format!(
                "{}?browse={}",
                current_url.as_str().trim_end_matches('/'),
                remote_encoded
            );
            if let Ok(url) = tauri::Url::parse(&new_url) {
                let _ = main_window.navigate(url);
            }
        }
    }

    main_window.show().unwrap_or_else(|e| {
        eprintln!("Failed to show main window: {e}");
    });
}
