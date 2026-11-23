//! The native tray icon, drawn with `tray-icon`. Its objects belong to the thread
//! that runs the UI event loop, so every change goes through
//! `Host::run_on_main_thread` and the icon itself lives in that thread's storage.
//!
//! Menu clicks arrive as `muda` menu events. Tauri takes `muda`'s single event handler
//! for itself, so a Tauri host receives them in `on_menu_event` and passes the id to
//! [`super::actions::handle_menu_id`].
use super::actions::TrayView;
use super::icon::TrayIconKind;
use super::menu::{MenuItemKind, MenuPlan};
use super::{TrayMenuState, TrayVisuals, build_tray_visuals, deliverable_visuals};
use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use log::{debug, error};
use std::cell::RefCell;
use std::sync::OnceLock;
use std::sync::atomic::Ordering;
use tray_icon::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};

thread_local! {
    /// Only the UI thread ever stores a tray here.
    static TRAY: RefCell<Option<TrayIcon>> = const { RefCell::new(None) };
}

/// Shows the tray at startup when the setting or the host (`--tray`) asks for it.
/// A host without a tray never manages [`TrayMenuState`], so nothing happens there.
pub async fn start(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<TrayMenuState>() else {
        return Ok(());
    };
    let settings = app
        .state::<AppSettingsManager>()
        .get_all()
        .map_err(|e| e.to_string())?;
    if settings.general.tray_enabled {
        state.requested_visible.store(true, Ordering::SeqCst);
    }
    if !state.requested_visible.load(Ordering::SeqCst) {
        return Ok(());
    }
    show(app).await
}

/// Shows the tray, creating it the first time.
pub async fn show(app: &AppHandle) -> Result<(), String> {
    let visuals = build_tray_visuals(app).await?;
    let task_app = app.clone();
    app.host()
        .run_on_main_thread(Box::new(move || create_or_show(&task_app, visuals)))
}

/// Rebuilds the tray in the background after something it shows changed. Until a
/// tray exists, which on a host without one is never, there is nothing to rebuild.
pub fn refresh_in_background(app: AppHandle) {
    if !app
        .try_state::<TrayMenuState>()
        .is_some_and(|state| state.built.load(Ordering::SeqCst))
    {
        return;
    }
    crate::utils::spawn(async move {
        if let Err(e) = refresh(&app).await {
            error!("Failed to update tray menu: {e}");
        }
    });
}

/// Coalesces rapid concurrent triggers into at most one update in flight and one
/// after it.
async fn refresh(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<TrayMenuState>() else {
        return Ok(());
    };
    // A tray that was switched off stays as it is.
    if !state.built.load(Ordering::SeqCst) || !state.requested_visible.load(Ordering::SeqCst) {
        return Ok(());
    }
    // A running update re-checks the flag before it finishes, so a request that finds
    // the lock taken only has to raise it.
    state.has_pending.store(true, Ordering::SeqCst);
    loop {
        let Ok(guard) = state.update_lock.try_lock() else {
            return Ok(());
        };
        while state.has_pending.swap(false, Ordering::SeqCst) {
            let visuals = build_tray_visuals(app).await?;
            let task_app = app.clone();
            app.host().run_on_main_thread(Box::new(move || {
                if let Err(error) = apply(&task_app, visuals) {
                    error!("Failed to apply tray visuals: {error}");
                }
            }))?;
        }
        // Release before the last check so a trigger arriving now cannot be lost.
        drop(guard);
        if !state.has_pending.load(Ordering::SeqCst) {
            return Ok(());
        }
    }
}

/// Shows or hides the tray. Showing one that was never created creates it.
pub fn set_visible(app: &AppHandle, enabled: bool) {
    let Some(state) = app.try_state::<TrayMenuState>() else {
        return;
    };
    state.requested_visible.store(enabled, Ordering::SeqCst);
    debug!("Tray visibility changed to: {enabled}");
    if state.built.load(Ordering::SeqCst) {
        let task_app = app.clone();
        let result = app.host().run_on_main_thread(Box::new(move || {
            let state = task_app.state::<TrayMenuState>();
            TRAY.with_borrow(|tray| {
                let Some(tray) = tray else { return };
                match tray.set_visible(enabled) {
                    Ok(()) => state.visible.store(enabled, Ordering::SeqCst),
                    Err(error) => error!("Failed to change tray visibility: {error}"),
                }
            });
        }));
        if let Err(error) = result {
            error!("Failed to change tray visibility: {error}");
        }
    } else if enabled {
        let app = app.clone();
        crate::utils::spawn(async move {
            if let Err(error) = show(&app).await {
                error!("Failed to set up tray: {error}");
            }
        });
    }
}

/// Removes the tray icon from the system tray. Call on the UI thread when the
/// event loop ends: a Windows icon that is never removed stays until the mouse
/// passes over it.
pub fn remove() {
    TRAY.with_borrow_mut(|tray| drop(tray.take()));
}

/// Removes the tray from any thread before the process ends without
/// `RunEvent::Exit`, such as a restart, waiting briefly for the UI thread.
pub fn remove_before_exit(app: &AppHandle) {
    let built = app
        .try_state::<TrayMenuState>()
        .is_some_and(|state| state.built.load(Ordering::SeqCst));
    if !built {
        return;
    }
    let (done, finished) = std::sync::mpsc::channel();
    let queued = app.host().run_on_main_thread(Box::new(move || {
        remove();
        let _ = done.send(());
    }));
    if queued.is_ok() {
        let _ = finished.recv_timeout(std::time::Duration::from_secs(2));
    }
}

/// Runs clicked tray entries, for a host that owns `muda`'s single event handler.
/// Tauri keeps that handler and passes ids from `on_menu_event` instead.
pub fn handle_menu_events(app: &AppHandle) {
    let app = app.clone();
    tray_icon::menu::MenuEvent::set_event_handler(Some(
        move |event: tray_icon::menu::MenuEvent| {
            super::actions::handle_menu_id(&app, event.id.as_ref());
        },
    ));
}

fn create_or_show(app: &AppHandle, visuals: TrayVisuals) {
    let state = app.state::<TrayMenuState>();
    if !state.requested_visible.load(Ordering::SeqCst) {
        return;
    }
    let shown = TRAY.with_borrow(|tray| {
        let tray = tray.as_ref()?;
        match tray.set_visible(true) {
            Ok(()) => state.visible.store(true, Ordering::SeqCst),
            Err(error) => error!("Failed to show existing tray: {error}"),
        }
        Some(())
    });
    if shown.is_some() {
        return;
    }
    let (plan, tooltip, icon_kind) = deliverable_visuals(app, &state, visuals);
    let menu = match build_menu(&plan) {
        Ok(menu) => menu,
        Err(error) => {
            error!("Failed to build tray menu: {error}");
            return;
        }
    };
    let built = TrayIconBuilder::new()
        .with_id("main-tray")
        .with_icon(icon(icon_kind))
        .with_tooltip(&tooltip)
        .with_menu(Box::new(menu))
        .build();
    match built {
        Ok(tray) => {
            TRAY.with_borrow_mut(|stored| *stored = Some(tray));
            listen_for_double_clicks(app);
            let mut cache = state.visuals();
            cache.plan = Some(plan);
            cache.tooltip = Some(tooltip);
            cache.icon = Some(icon_kind);
            drop(cache);
            state.built.store(true, Ordering::SeqCst);
            state.visible.store(true, Ordering::SeqCst);
        }
        // No tray to draw on, such as a server without a desktop session, which is
        // expected and needs no warning: the rest of the application works without one.
        Err(e) => debug!("System tray unavailable, continuing without it: {e}"),
    }
}

/// A double click opens the main window. A web UI host opens nothing: the browser
/// is reached through the menu.
fn listen_for_double_clicks(app: &AppHandle) {
    if super::web_ui(app) {
        return;
    }
    let app = app.clone();
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } = event
        {
            app.host().open_view(TrayView::Main);
        }
    }));
}

fn apply(app: &AppHandle, visuals: TrayVisuals) -> Result<(), String> {
    TRAY.with_borrow(|tray| {
        let Some(tray) = tray else {
            debug!("Tray menu update skipped: tray not found");
            return Ok(());
        };
        let state = app.state::<TrayMenuState>();
        let (plan, tooltip, icon_kind) = deliverable_visuals(app, &state, visuals);
        let (plan_changed, tooltip_changed, icon_changed) =
            state.visuals().diff(&plan, &tooltip, icon_kind);

        // Commit each successful change so a later failure cannot leave the cache stale.
        if plan_changed {
            tray.set_menu(Some(Box::new(build_menu(&plan)?)));
            state.visuals().plan = Some(plan);
        }
        if icon_changed {
            tray.set_icon(Some(icon(icon_kind)))
                .map_err(|e| e.to_string())?;
            state.visuals().icon = Some(icon_kind);
        }
        if tooltip_changed {
            tray.set_tooltip(Some(&tooltip))
                .map_err(|e| e.to_string())?;
            state.visuals().tooltip = Some(tooltip);
        }
        Ok(())
    })
}

fn build_menu(plan: &MenuPlan) -> Result<Menu, String> {
    let items = plan
        .items
        .iter()
        .map(native_item)
        .collect::<Result<Vec<_>, _>>()?;
    let refs: Vec<&dyn IsMenuItem> = items.iter().map(AsRef::as_ref).collect();
    Menu::with_items(&refs).map_err(|e| e.to_string())
}

fn native_item(kind: &MenuItemKind) -> Result<Box<dyn IsMenuItem>, String> {
    Ok(match kind {
        MenuItemKind::Separator => Box::new(PredefinedMenuItem::separator()),
        MenuItemKind::Regular(item) => Box::new(MenuItem::with_id(
            item.id.as_str(),
            &item.label,
            item.enabled,
            None,
        )),
        MenuItemKind::Check(item) => Box::new(CheckMenuItem::with_id(
            item.id.as_str(),
            &item.label,
            item.enabled,
            item.checked,
            None,
        )),
        MenuItemKind::Submenu(submenu) => {
            let children = submenu
                .items
                .iter()
                .map(native_item)
                .collect::<Result<Vec<_>, _>>()?;
            let refs: Vec<&dyn IsMenuItem> = children.iter().map(AsRef::as_ref).collect();
            Box::new(
                Submenu::with_items(&submenu.label, submenu.enabled, &refs)
                    .map_err(|e| e.to_string())?,
            )
        }
    })
}

const ICONS: [&[u8]; 6] = [
    include_bytes!("icons/rclone_symbolic.png"),
    include_bytes!("icons/rclone_symbolic_active.png"),
    include_bytes!("icons/rclone_monochrome_light.png"),
    include_bytes!("icons/rclone_monochrome_light_active.png"),
    include_bytes!("icons/rclone_monochrome_dark.png"),
    include_bytes!("icons/rclone_monochrome_dark_active.png"),
];

/// Panels draw tray icons at 16 to 48 pixels; the PNGs are 512. Each icon is decoded
/// once, the first time it is shown, at a size that stays sharp on high-DPI panels
/// and that the D-Bus tray can send on every change.
const ICON_SIZE: u32 = 64;

/// The decoded RGBA pixels of an icon.
fn pixels(kind: TrayIconKind) -> &'static (Vec<u8>, u32, u32) {
    static DECODED: [OnceLock<(Vec<u8>, u32, u32)>; 6] = [const { OnceLock::new() }; 6];
    DECODED[kind as usize].get_or_init(|| {
        let image =
            image::load_from_memory_with_format(ICONS[kind as usize], image::ImageFormat::Png)
                .expect("embedded icon PNG is valid")
                .resize(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
                .into_rgba8();
        let (width, height) = image.dimensions();
        (image.into_raw(), width, height)
    })
}

fn icon(kind: TrayIconKind) -> Icon {
    let (rgba, width, height) = pixels(kind);
    Icon::from_rgba(rgba.clone(), *width, *height).expect("embedded icon has valid dimensions")
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [TrayIconKind; 6] = [
        TrayIconKind::ColorNormal,
        TrayIconKind::ColorActive,
        TrayIconKind::MonoLightNormal,
        TrayIconKind::MonoLightActive,
        TrayIconKind::MonoDarkNormal,
        TrayIconKind::MonoDarkActive,
    ];

    #[test]
    fn every_icon_kind_decodes_to_rgba_pixels() {
        for kind in KINDS {
            let (rgba, width, height) = pixels(kind);
            assert!(*width > 0 && *height > 0);
            assert_eq!(rgba.len(), (*width * *height * 4) as usize);
        }
        // The 16-bit symbolic icons are converted, not reinterpreted.
        assert_eq!(pixels(TrayIconKind::ColorNormal).1, ICON_SIZE);
    }

    #[tokio::test]
    async fn concurrent_refreshes_without_a_tray_need_no_backend_state() {
        let app = AppHandle::default();
        let tasks: Vec<_> = (0..50)
            .map(|_| {
                let app = app.clone();
                crate::utils::spawn(async move { refresh(&app).await })
            })
            .collect();
        for task in futures::future::join_all(tasks).await {
            task.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn a_tray_that_was_switched_off_is_not_rebuilt() {
        let app = AppHandle::default();
        let state = TrayMenuState::default();
        state.built.store(true, Ordering::SeqCst);
        app.manage(state);
        // No settings exist: building the menu would fail the refresh.
        refresh(&app).await.unwrap();
    }

    #[tokio::test]
    async fn an_unbuilt_tray_is_not_refreshed() {
        let app = AppHandle::default();
        app.manage(TrayMenuState::default());
        // No host UI thread exists: reaching it would fail the refresh.
        refresh(&app).await.unwrap();
    }
}
