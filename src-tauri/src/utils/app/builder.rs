use tauri::{
    AppHandle, Emitter,
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::core::tray::{actions::show_main_window, menu::create_tray_menu};

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

    app.emit("tray_menu_updated", ())?;
    Ok(())
}

pub fn create_app_window(app_handle: AppHandle) {
    let main_window =
        tauri::WebviewWindowBuilder::new(&app_handle, "main", tauri::WebviewUrl::default())
            .title("Rclone Manager")
            .inner_size(800.0, 630.0)
            .resizable(true)
            .center()
            .shadow(false)
            .min_inner_size(362.0, 240.0);

    // MacOS does not support transparent windows. So we set the title bar style to show
    // and remove the decorations.
    // On other platforms, we set the decorations to false and make the window transparent.
    #[cfg(target_os = "macos")]
    let main_window = main_window.title_bar_style(tauri::TitleBarStyle::Visible);

    #[cfg(not(target_os = "macos"))]
    let main_window = main_window.decorations(false).transparent(true);

    let main_window = main_window.build().expect("Failed to build main window");

    main_window.show().unwrap_or_else(|e| {
        eprintln!("Failed to show main window: {e}");
    });
}
