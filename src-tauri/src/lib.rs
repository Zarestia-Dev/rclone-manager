use core::{settings::open_in_files, tray::setup_tray};
use rclone::api::{
    create_remote, delete_remote, ensure_rc_api_running, get_all_mount_configs,
    get_all_remote_configs, get_copy_flags, get_disk_usage, get_filter_flags, get_global_flags,
    get_mount_flags, get_mount_types, get_mounted_remotes, get_remote_config,
    get_remote_config_fields, get_remote_types, get_remotes, get_sync_flags, get_vfs_flags,
    list_mounts, mount_remote, save_mount_config, unmount_remote, update_remote, RcloneState,
};
use reqwest::Client;
use std::{
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{Manager, Theme, WindowEvent};
use tauri_plugin_http::reqwest;
use utils::{
    check_rclone::{check_rclone_installed, provision_rclone},
    file_helper::get_folder_location,
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
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                setup_tray(&app_handle).await.expect("Failed to setup tray");
            });
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
            get_folder_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
