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
    let icon = icon_kind.to_image();

    app.run_on_main_thread(move || {
        let state = app_clone.backend_state::<crate::desktop::tray::TrayMenuState>();
        if !state
            .requested_visible
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        if let Some(tray) = app_clone.tray_by_id("main-tray") {
            match tray.set_visible(true) {
                Ok(()) => state
                    .visible
                    .store(true, std::sync::atomic::Ordering::SeqCst),
                Err(error) => log::error!("Failed to show existing tray: {error}"),
            }
            return;
        }
        let plan = if crate::services::settings::access::is_locked(app_clone.backend()) {
            MenuPlan::locked()
        } else {
            plan
        };
        let tray_menu = match create_tray_menu_from_plan(&app_clone, &plan) {
            Ok(menu) => menu,
            Err(error) => {
                log::error!("Failed to build tray menu: {error}");
                return;
            }
        };
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

        match tray.build(&app_clone) {
            Ok(_) => {
                let mut cache = state.cache.lock().unwrap();
                cache.plan = Some(plan);
                cache.tooltip = Some(rclone_manager_core::t!("tray.tooltipDefault"));
                cache.icon = Some(icon_kind);
                state
                    .visible
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Err(e) => log::error!("Failed to build tray icon: {e}"),
        }
    })?;

    Ok(())
}
