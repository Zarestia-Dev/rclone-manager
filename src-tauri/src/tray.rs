use tauri::{Manager, AppHandle};
use std::path::PathBuf;
use tauri::async_runtime::spawn;
use std::time::Duration;

fn build_menu(app: &AppHandle) -> SystemTrayMenu {
    let show = CustomMenuItem::new("show".to_string(), "Show");
    let settings = CustomMenuItem::new("settings".to_string(), "Settings");
    let open_config = CustomMenuItem::new("open_config".to_string(), "Open Config File");
    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    
    SystemTrayMenu::new()
        .add_item(show)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(settings)
        .add_item(open_config)
        .add_native_item(SystemTrayMenuItem::Separator)
}

fn resolve_resource(resource: &str) -> Option<PathBuf> {
    let mut path = std::env::current_exe().ok()?;
    path.pop();
    path.push(resource);
    Some(path)
}

pub fn init_main_tray() -> SystemTray {
    let icon_path = resolve_resource("icons/favicon/icon.png")
        .expect("Failed to resolve tray icon")
        .to_string_lossy()
        .into_owned();

    SystemTray::new()
        .with_id("main-tray")
        .with_icon(icon_path)
        .with_tooltip("Rclone")
        .with_menu(build_menu())
        .on_event(|event| {
            if let SystemTrayEvent::LeftClick { .. } = event {
                let app = event.window().app_handle();
                app.emit_all("reset-main-window", ()).unwrap();
            }
        })
}


pub fn init_loading_tray() -> Option<SystemTray> {
    if cfg!(target_os = "linux") {
        return None;
    }

    let icon_path = resolve_resource("icons/favicon/frame_00_delay-0.1s.png")
        ?
        .to_string_lossy()
        .into_owned();

    let quit = CustomMenuItem::new("quit-loading".to_string(), "Quit");
    let menu = SystemTrayMenu::new().add_item(quit);

    let mut tray = SystemTray::new()
        .with_id("loading-tray")
        .with_icon(icon_path)
        .with_menu(menu);

    // Start animation
    spawn(async move {
        let mut current_icon = 1;
        loop {
            if current_icon > 17 {
                current_icon = 1;
            }
            
            let icon_path = resolve_resource(&format!(
                "icons/favicon/frame_{:02}_delay-0.1s.png",
                current_icon
            )).unwrap().to_string_lossy().into_owned();
            
            tray.set_icon(icon_path).unwrap();
            current_icon += 1;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });

    Some(tray)
}