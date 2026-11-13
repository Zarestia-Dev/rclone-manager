use super::core::{build_tray_visuals, deliverable_visuals};
use super::{TrayMenuState, menu::create_tray_menu_from_plan};
use crate::context::BackendContext;
use crate::services::settings::AppSettingsManager;
use std::sync::atomic::Ordering;

pub async fn setup_tray(app: tauri::AppHandle) -> tauri::Result<()> {
    let state = app.backend_state::<TrayMenuState>();
    let settings_manager = app.backend_state::<AppSettingsManager>();
    let visuals = build_tray_visuals(&app, &state, &settings_manager).await?;

    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        let state = app_clone.backend_state::<TrayMenuState>();
        if !state.requested_visible.load(Ordering::SeqCst) {
            return;
        }
        if let Some(tray) = app_clone.tray_by_id("main-tray") {
            match tray.set_visible(true) {
                Ok(()) => state.visible.store(true, Ordering::SeqCst),
                Err(error) => log::error!("Failed to show existing tray: {error}"),
            }
            return;
        }
        let (plan, tooltip, icon_kind) = deliverable_visuals(&app_clone, &state, visuals);
        let tray_menu = match create_tray_menu_from_plan(&app_clone, &plan) {
            Ok(menu) => menu,
            Err(error) => {
                log::error!("Failed to build tray menu: {error}");
                return;
            }
        };
        let tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
            .icon(icon_kind.to_image())
            .tooltip(&tooltip)
            .menu(&tray_menu);

        #[cfg(not(feature = "web-server"))]
        let tray = tray.on_tray_icon_event(move |tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                crate::desktop::window::present_main_window(tray.app_handle());
            }
        });

        match tray.build(&app_clone) {
            Ok(_) => {
                let mut cache = state.visuals();
                cache.plan = Some(plan);
                cache.tooltip = Some(tooltip);
                cache.icon = Some(icon_kind);
                state.visible.store(true, Ordering::SeqCst);
            }
            Err(e) => log::error!("Failed to build tray icon: {e}"),
        }
    })?;

    Ok(())
}
