use core::{
    settings::{load_settings, save_settings, SettingsState},
    settings_store::AppSettings,
    tray::setup_tray,
};
use rclone::api::{
    create_remote, delete_remote, ensure_rc_api_running, get_all_mount_configs,
    get_all_remote_configs, get_copy_flags, get_disk_usage, get_filter_flags, get_global_flags,
    get_mount_flags, get_mount_types, get_mounted_remotes, get_remote_config,
    get_remote_config_fields, get_remote_types, get_remotes, get_sync_flags, get_vfs_flags,
    list_mounts, mount_remote, save_mount_config, unmount_remote, update_remote, RcloneState,
};
use reqwest::Client;
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{Manager, Theme, WindowEvent};
use tauri_plugin_http::reqwest;
use tauri_plugin_store::StoreBuilder;
use utils::{
    check_rclone::{check_rclone_installed, provision_rclone},
    file_helper::{get_folder_location, open_in_files},
};

mod core;
mod rclone;
mod utils;

#[tauri::command]
fn set_theme(theme: String, window: tauri::Window) {
    let theme = match theme.as_str() {
        "dark" => Theme::Dark,
        _ => Theme::Light,
    };
    window.set_theme(Some(theme)).expect("Failed to set theme");
}

fn lower_webview_priority() {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd")
            .args(&[
                "/C",
                "wmic process where name='WebView2.exe' CALL setpriority 64",
            ])
            .output();
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("renice")
            .args(&["-n", "19", "-p", &std::process::id().to_string()])
            .output();

        print!("Lowered priority");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let rc_process = Arc::new(Mutex::new(None));
    ensure_rc_api_running(rc_process.clone()); // ✅ Ensures RC API is running

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        // .on_window_event(|window, event| match event {
        //     tauri::WindowEvent::CloseRequested { api, .. } => {
        //         api.prevent_close();
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.hide();
        //         }
        //     }
        //     _ => {}
        // }) // ✅ Prevent window close and hide instead
        // .on_window_event(|window, event| match event {
        //     WindowEvent::CloseRequested { api, .. } => {
        //         api.prevent_close();
        //         api.prevent_close();
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.hide();
        //             let _ = win.eval("document.body.innerHTML = '';"); // ✅ Clear UI content to free memory
        //         }
        //     }
        //     WindowEvent::Focused(false) => {
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.eval("document.body.innerHTML = '';"); // ✅ Clear UI when unfocused
        //         }
        //     }
        //     WindowEvent::Focused(true) => {
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.eval("location.reload();"); // ✅ Reload UI when refocused
        //         }
        //     }
        //     _ => {}
        // }) // ✅ Clear UI content when window is hidden
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(win) = window.app_handle().get_webview_window("main") {
                    let _ = win.hide();
                    lower_webview_priority(); // ✅ Reduce WebView CPU usage
                }
            }
            WindowEvent::Focused(true) => {
                if let Some(win) = window.app_handle().get_webview_window("main") {
                    let _ = win.show();
                }
            }
            _ => {}
        }) // ✅ Hide window on close and show on focus
        .manage(RcloneState {
            client: Client::new(),
        })
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle();

            // ✅ Read command-line arguments
            let args: Vec<String> = std::env::args().collect();
            let start_with_tray = args.contains(&"--tray".to_string());

            // ✅ Store settings in a proper directory
            let store_path: PathBuf = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory")
                .join("settings.json");

            println!("Settings file path: {:?}", store_path); // ✅ Debugging log

            // ✅ Ensure the parent directory exists
            if let Some(parent) = store_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create settings directory: {}", e))?;
            }

            // ✅ Create settings store
            let store = Arc::new(Mutex::new(
                StoreBuilder::new(&app_handle.clone(), store_path.clone())
                    .build()
                    .expect("Failed to create settings store"),
            ));

            // ✅ Register `SettingsState` before using it
            app.manage(SettingsState {
                store: store.clone(),
            });

            // ✅ Load settings using `block_on()`
            let settings = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .unwrap_or_else(|err| {
                println!("⚠️ Failed to load settings: {}. Using defaults.", err);
                AppSettings::default()
            });

            println!("Loaded Settings: {:?}", settings);

            // ✅ Handle start_minimized
            if settings.start_minimized {
                println!("Hiding window");
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            // ✅ Handle `--tray` argument OR `start_minimized` setting
            if start_with_tray || settings.start_minimized {
                println!("Hiding window (start minimized or tray mode)");
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            // ✅ Handle tray_enabled
            if settings.tray_enabled {
                println!("Setting up tray");
                let tray_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = setup_tray(&tray_handle).await {
                        eprintln!("Failed to setup tray: {}", e);
                    }
                });
            } else {
                println!("Tray is disabled in settings");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_theme,
            check_rclone_installed,
            provision_rclone,
            get_all_remote_configs,
            get_all_mount_configs,
            get_disk_usage,
            list_mounts,
            mount_remote,
            unmount_remote,
            get_remotes,
            get_remote_config,
            get_remote_types,
            get_mount_types,
            get_remote_config_fields,
            create_remote,
            update_remote,
            delete_remote,
            get_global_flags,
            get_copy_flags,
            get_sync_flags,
            get_filter_flags,
            get_vfs_flags,
            get_mount_flags,
            save_mount_config,
            get_mounted_remotes,
            open_in_files,
            get_folder_location,
            load_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
