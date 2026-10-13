use crate::context::BackendContext;
pub async fn setup_tray(app: tauri::AppHandle) -> tauri::Result<()> {
    let app_clone = app.clone();
    use crate::desktop::tray::TraySnapshot;
    use crate::desktop::tray::menu::{MenuPlan, create_tray_menu_from_plan};
    use crate::services::settings::AppSettingsManager;

    let snapshot = TraySnapshot::fetch(&app_clone).await?;

    // Build plan off main thread
    let (plan, icon_theme) = {
        let settings_manager = app_clone.backend_state::<AppSettingsManager>();
        let settings = settings_manager
            .get_all()
            .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;
        let max_tray_items = settings.core.max_tray_items;
        let icon_theme = settings.general.tray_icon_theme;
        (MenuPlan::build(&snapshot, max_tray_items), icon_theme)
    };

    let icon_kind = crate::desktop::tray::icon::TrayIconKind::resolve(false, &icon_theme);
    let tray_menu = create_tray_menu_from_plan(&app, &plan)?;
    let icon = icon_kind.to_image();

    if let Some(state) = app.backend_try_state::<crate::desktop::tray::TrayMenuState>() {
        let mut cache = state.cache.lock().unwrap();
        cache.plan = Some(plan.clone());
        cache.tooltip = Some(rclone_manager_core::t!("tray.tooltipDefault"));
        cache.icon = Some(icon_kind);
    }

    app.run_on_main_thread(move || {
        let tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
            .icon(icon)
            .tooltip(rclone_manager_core::t!("tray.tooltipDefault"))
            .menu(&tray_menu);

        #[cfg(not(feature = "web-server"))]
        let tray = tray.on_tray_icon_event(move |tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                crate::desktop::tray::actions::show_main_window(tray.app_handle().clone());
            }
        });

        if let Err(e) = tray.build(&app_clone) {
            log::error!("Failed to build tray icon: {e}");
        }
    })?;

    Ok(())
}
