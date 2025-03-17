use rclone_manager_lib::api::is_rc_api_running;
use rclone_manager_lib::api::mount_remote;
use rclone_manager_lib::config::load_config;
use rclone_manager_lib::config::save_config;
use rclone_manager_lib::mount::mount_remote_rust;
use rclone_manager_lib::tracker::start_mount_tracker;
use std::process::Command;
use tauri::tray::TrayIconBuilder;
// mod tray;

#[tauri::command]
async fn mount_remote_handler(remote: String, mount_point: String) -> Result<String, String> {
    let config = load_config();

    if config.use_rc_api {
        mount_remote(remote.clone(), mount_point.clone()).await
    } else {
        mount_remote_rust(&remote, &mount_point)
    }
}

#[tauri::command]
fn toggle_mount_method() -> String {
    let mut config = load_config();
    config.use_rc_api = !config.use_rc_api;
    save_config(&config);
    format!(
        "Mount method set to: {}",
        if config.use_rc_api {
            "RC API"
        } else {
            "Rust Threads"
        }
    )
}

fn ensure_rc_api_running() {
    if !tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(is_rc_api_running())
    {
        println!("Starting Rclone RC API...");
        Command::new("rclone")
            .args(&[
                "rcd",
                "--rc-no-auth",
                "--rc-serve",
                "--rc-addr=localhost:5572",
            ])
            .spawn()
            .expect("Failed to start Rclone RC API");
    }
}

fn main() {
    ensure_rc_api_running(); // Start RC API if not running
    start_mount_tracker(); // Start monitoring thread

    use tauri::{
        Manager,
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}
    };
    
    TrayIconBuilder::<tauri::Wry>::new()
      .on_tray_icon_event(|tray, event| match event {
        TrayIconEvent::Click {
          button: MouseButton::Left,
          button_state: MouseButtonState::Up,
          ..
        } => {
          println!("left click pressed and released");
          // in this example, let's show and focus the main window when the tray is clicked
          let app = tray.app_handle();
          if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
          }
        }
        _ => {
          println!("unhandled event {event:?}");
        }
      });

    rclone_manager_lib::run()
}
