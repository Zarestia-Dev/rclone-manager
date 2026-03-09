// =============================================================================
// RCLONE MANAGER - MAIN LIBRARY ENTRY POINT
// =============================================================================

// =============================================================================
// STANDARD LIBRARY & EXTERNAL CRATES
// =============================================================================
use crate::core::settings::schema::AppSettings;
use log::{debug, error, info};
use std::sync::atomic::AtomicBool;
use tauri::Manager;

use clap::Parser;
#[cfg(not(feature = "web-server"))]
use tauri::WindowEvent;

// =============================================================================
// INTERNAL MODULES
// =============================================================================
mod core;
mod rclone;
pub mod utils;

#[cfg(feature = "web-server")]
mod server;

// =============================================================================
// SHARED IMPORTS (Both modes)
// =============================================================================
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::utils::logging::log::init_logging;
use crate::{
    core::{
        initialization::initialization,
        lifecycle::{shutdown::shutdown_app, startup::handle_startup},
        paths::AppPaths,
        scheduler::engine::CronScheduler,
    },
    utils::types::{
        core::{RcApiEngine, RcloneState},
        logs::LogCache,
        updater::{AppUpdaterState, RcloneUpdaterState},
    },
};

// CONDITIONAL IMPORTS: Desktop Tray
// =============================================================================
#[cfg(all(desktop, not(feature = "web-server")))]
use crate::core::tray::actions::handle_browse_remote;
#[cfg(desktop)]
use crate::core::tray::{
    actions::{
        handle_bisync_profile, handle_copy_profile, handle_mount_profile, handle_move_profile,
        handle_serve_profile, handle_stop_all_jobs, handle_stop_all_serves,
        handle_stop_bisync_profile, handle_stop_copy_profile, handle_stop_move_profile,
        handle_stop_serve_profile, handle_stop_sync_profile, handle_sync_profile,
        handle_unmount_profile,
    },
    tray_action::TrayAction,
};

#[cfg(all(desktop, not(feature = "web-server")))]
use crate::utils::app::builder::create_app_window;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::utils::io::network::monitor_network_changes;

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // -------------------------------------------------------------------------
    // Parse CLI args
    // -------------------------------------------------------------------------
    let cli_args: crate::core::cli::CliArgs = match crate::core::cli::CliArgs::try_parse() {
        Ok(args) => {
            // Validate CLI args early - fail fast for logical inconsistencies
            if let Err(e) = args.validate() {
                eprintln!("❌ Invalid CLI arguments: {}", e);
                std::process::exit(1);
            }
            args
        }
        Err(e) => {
            // If it's a help or version request, clap handles it and exits.
            // For other errors (like invalid flags):
            // - On Headless: fail fast as it's likely a config error in Docker/Script.
            // - On Desktop: we might want to be more lenient, but claps default
            //               behavior is to print and exit.
            // Given we use Flatten, invalid flags for one feature might trigger errors.
            // For now, mirroring claps default behavior but allowing future flexibility.
            e.exit();
        }
    };

    // -------------------------------------------------------------------------
    // Initialize Tauri Builder
    // -------------------------------------------------------------------------
    let mut builder = tauri::Builder::default();

    // Manage CLI args state early so it's available for path resolution
    builder = builder.manage(cli_args.clone());

    // -------------------------------------------------------------------------
    // Custom Protocol for Remote File Streaming (Desktop)
    // -------------------------------------------------------------------------
    builder =
        builder.register_asynchronous_uri_scheme_protocol("rclone", |app, request, responder| {
            // 1. Handle CORS Preflight for Angular's HttpClient
            if request.method() == tauri::http::Method::OPTIONS {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(204)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .body(vec![])
                        .unwrap(),
                );
                return;
            }

            // capture an incoming Range header so we can forward it later
            let range_header = request
                .headers()
                .get("Range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let uri = request.uri().to_string();
            // On Linux/macOS (WebKit) the URI is "rclone://remote/path".
            // On Windows (WebView2), frontend sends "http://rclone.localhost/remote/path"
            // but WebView2 transforms it to "rclone://localhost/remote/path" when routing to handler.
            debug!("🔍 rclone protocol handler received URI: {}", uri);
            let path_part = if let Some(stripped) = uri.strip_prefix("rclone://localhost/") {
                // Windows WebView2 format after transformation
                stripped
            } else if let Some(stripped) = uri.strip_prefix("rclone://") {
                // Unix format
                stripped
            } else if let Some(stripped) = uri.strip_prefix("http://rclone.localhost/") {
                // Fallback if WebView2 doesn't transform
                stripped
            } else {
                &uri
            };

            // Find the first slash to separate remote from path
            let (remote, path) = match path_part.find('/') {
                Some(idx) => (&path_part[..idx], &path_part[idx + 1..]),
                None => (path_part, ""),
            };

            let app_handle = app.app_handle().clone();
            let remote = match urlencoding::decode(remote) {
                Ok(decoded) => {
                    let mut r = decoded.into_owned();
                    // Restore the trailing colon stripped from the URL host by the frontend
                    // (rclone remote names have the format "name:", but colons are invalid
                    // in URL hostnames so the frontend omits it)
                    if !r.ends_with(':') {
                        r.push(':');
                    }
                    r
                }
                Err(_) => {
                    let mut r = remote.to_string();
                    if !r.ends_with(':') {
                        r.push(':');
                    }
                    r
                }
            };
            let path = match urlencoding::decode(path) {
                Ok(decoded) => decoded.into_owned(),
                Err(_) => path.to_string(),
            };

            debug!("🔍 Parsed remote: '{}', path: '{}'", remote, path);

            tauri::async_runtime::spawn(async move {
                use crate::rclone::backend::BackendManager;
                let backend_manager = app_handle.state::<BackendManager>();
                let backend: crate::rclone::backend::types::Backend =
                    backend_manager.get_active().await;

                let rclone_state = app_handle.state::<crate::utils::types::core::RcloneState>();
                let client = &rclone_state.client;

                // forward Range header to rclone so we only fetch the requested bytes
                match backend
                    .fetch_file_stream_with_range(client, &remote, &path, range_header.as_deref())
                    .await
                {
                    Ok(response) => {
                        let status = response.status();
                        let is_range_response = status == reqwest::StatusCode::PARTIAL_CONTENT;
                        let content_type = response
                            .headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("application/octet-stream")
                            .to_string();
                        let content_range = response
                            .headers()
                            .get(reqwest::header::CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        let content_length = response
                            .headers()
                            .get(reqwest::header::CONTENT_LENGTH)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        let accept_ranges = response
                            .headers()
                            .get(reqwest::header::ACCEPT_RANGES)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("bytes")
                            .to_string();

                        if status.is_success() {
                            match response.bytes().await {
                                Ok(bytes) => {
                                    let mut builder = tauri::http::Response::builder()
                                        .status(if is_range_response { 206 } else { 200 })
                                        .header(tauri::http::header::CONTENT_TYPE, content_type)
                                        .header("Access-Control-Allow-Origin", "*")
                                        .header("Accept-Ranges", accept_ranges);

                                    if let Some(cr) = content_range {
                                        builder = builder.header("Content-Range", cr);
                                    }
                                    if let Some(cl) = content_length {
                                        builder = builder.header("Content-Length", cl);
                                    }

                                    responder.respond(builder.body(bytes.to_vec()).unwrap());
                                }
                                Err(e) => {
                                    error!("❌ Stream read error for {}: {}", remote, e);
                                    responder.respond(
                                        tauri::http::Response::builder()
                                            .status(500)
                                            .header("Access-Control-Allow-Origin", "*")
                                            .body(format!("Stream read error: {}", e).into_bytes())
                                            .unwrap(),
                                    );
                                }
                            }
                        } else {
                            responder.respond(
                                tauri::http::Response::builder()
                                    .status(status.as_u16())
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(format!("Rclone error: {}", status).into_bytes())
                                    .unwrap(),
                            );
                        }
                    }
                    Err(e) => {
                        error!("❌ Proxy error fetching {}:{} - {}", remote, path, e);
                        responder.respond(
                            tauri::http::Response::builder()
                                .status(500)
                                .header("Access-Control-Allow-Origin", "*")
                                .body(format!("Proxy error: {}", e).into_bytes())
                                .unwrap(),
                        );
                    }
                }
            });
        });

    // -------------------------------------------------------------------------
    // Custom Protocol for Local Files Bypass (Desktop)
    // -------------------------------------------------------------------------
    builder = builder.register_uri_scheme_protocol("local-asset", |_app, request| {
        // 1. Handle CORS Preflight for Angular's HttpClient
        if request.method() == tauri::http::Method::OPTIONS {
            return tauri::http::Response::builder()
                .status(204)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                .header("Access-Control-Allow-Headers", "*") // Required for Angular
                .body(vec![])
                .unwrap();
        }

        let uri = request.uri().to_string();
        debug!("🔍 local-asset protocol handler received URI: {}", uri);

        // Handle the prefix mapping across different OS webviews
        // Safely strip the 'localhost' authority we added in Angular to prevent Tauri parsing panics
        let path_part = if let Some(stripped) = uri.strip_prefix("local-asset://localhost") {
            stripped // Leaves the leading slash, e.g., "/home/user"
        } else if let Some(stripped) = uri.strip_prefix("http://local-asset.localhost") {
            stripped
        } else if let Some(stripped) = uri.strip_prefix("local-asset://") {
            stripped
        } else {
            &uri
        };

        // Decode URL encoding (e.g., %20 to space)
        let decoded_path = match urlencoding::decode(path_part) {
            Ok(decoded) => decoded.into_owned(),
            Err(_) => path_part.to_string(),
        };

        // On Windows, the browser might pass an extra leading slash (e.g., /Z:/folder/file.ext)
        #[cfg(target_os = "windows")]
        let decoded_path = {
            let mut decoded_path = decoded_path;
            if decoded_path.starts_with('/') && decoded_path.chars().nth(2) == Some(':') {
                decoded_path = decoded_path[1..].to_string();
            }
            decoded_path
        };

        debug!("🔍 Final decoded path: '{}'", decoded_path);

        // 1. Determine mime type so the browser knows how to render it (image, pdf, etc.)
        let mime_type = mime_guess::from_path(&decoded_path)
            .first_or_octet_stream()
            .to_string();

        // 2. Open the file
        let mut file = match std::fs::File::open(&decoded_path) {
            Ok(f) => f,
            Err(e) => {
                error!("❌ Failed to open local asset '{}': {}", decoded_path, e);
                return tauri::http::Response::builder()
                    .status(404)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(format!("File not found: {}", e).into_bytes())
                    .unwrap();
            }
        };

        let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
        debug!(
            "✅ Opened local asset: {} (size: {} bytes)",
            decoded_path, file_size
        );

        // 3. Handle HTTP 206 Partial Content (Required for <video> tags to stream without crashing)
        let mut start = 0;
        let mut end = if file_size > 0 { file_size - 1 } else { 0 };
        let mut is_range_request = false;

        if let Some(range_val) = request.headers().get("Range").and_then(|v| v.to_str().ok())
            && let Some(stripped) = range_val.strip_prefix("bytes=")
        {
            // Browser requested a byte range; parse start/end values.
            is_range_request = true;
            let parts: Vec<&str> = stripped.split('-').collect();
            if let Some(s) = parts.first().and_then(|s| s.parse::<u64>().ok()) {
                start = s;
            }
            if parts.len() > 1
                && !parts[1].is_empty()
                && let Ok(e) = parts[1].parse::<u64>()
            {
                end = e;
            }
        }

        // Safety bound: don't read past the end of the file
        if end >= file_size && file_size > 0 {
            end = file_size - 1;
        }

        // Prevent underflow panic if range start > end
        if start > end {
            return tauri::http::Response::builder()
                .status(416) // Range Not Satisfiable
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Range", format!("bytes */{}", file_size))
                .body(vec![])
                .unwrap();
        }

        // Cap chunk size to 2MB to prevent RAM exhaustion on huge MP4s.
        // only apply the limit when the browser actually requested a range;
        // a straight GET should return the full file (or whatever the app asks for).
        let max_chunk_size = 2 * 1024 * 1024;
        let mut chunk_size = if file_size > 0 {
            (end - start + 1) as usize
        } else {
            0
        };

        let mut is_truncated = false;
        if is_range_request && chunk_size > max_chunk_size {
            chunk_size = max_chunk_size;
            end = start + chunk_size as u64 - 1;
            is_truncated = true;
        }

        // Read exactly the requested bytes into our chunk buffer
        let mut buffer = vec![0; chunk_size];
        if file_size > 0 {
            use std::io::{Read, Seek, SeekFrom};
            if let Err(e) = file.seek(SeekFrom::Start(start)) {
                error!("❌ Seek error in local asset '{}': {}", decoded_path, e);
                return tauri::http::Response::builder()
                    .status(500)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(format!("Seek error: {}", e).into_bytes())
                    .unwrap();
            }
            // We use read_exact, but ignore errors in case EOF is hit early unexpectedly
            let _ = file.read_exact(&mut buffer);
        }

        let response_builder = tauri::http::Response::builder()
            .header(tauri::http::header::CONTENT_TYPE, mime_type)
            .header("Access-Control-Allow-Origin", "*")
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", chunk_size.to_string());

        // FORCE a 206 Partial Content response if it was a Range request OR if we forcefully truncated the payload.
        // WebKit2GTK / GStreamer will fail if a standard GET is truncated but returns 200 OK.
        if (is_range_request || is_truncated) && file_size > 0 {
            response_builder
                .status(206)
                .header(
                    "Content-Range",
                    format!("bytes {}-{}/{}", start, end, file_size),
                )
                .body(buffer)
                .unwrap()
        } else {
            response_builder.status(200).body(buffer).unwrap()
        }
    });

    // -------------------------------------------------------------------------
    // Single Instance Plugin (Desktop)
    // -------------------------------------------------------------------------
    #[cfg(desktop)]
    {
        #[cfg(target_os = "linux")]
        {
            builder = builder.plugin(
                tauri_plugin_single_instance::Builder::new()
                    .dbus_id("io.github.zarestia_dev.rclone-manager")
                    .callback(|_app: &tauri::AppHandle, _, _| {
                        #[cfg(feature = "web-server")]
                        info!("Another instance attempted to run.");

                        #[cfg(not(feature = "web-server"))]
                        {
                            // Only show window if it exists, don't try to create
                            // Creating from single instance callback can cause crashes
                            if let Some(window) = _app.get_webview_window("main") {
                                info!("📢 Second instance detected, showing existing window");
                                let _ = window.show();
                                let _ = window.set_focus();
                            } else {
                                info!("📢 Second instance detected, but window was destroyed. Use tray to reopen.");
                                crate::utils::app::notification::send_notification_typed(
                                    _app,
                                    crate::utils::app::notification::Notification::localized(
                                        "notification.title.alreadyRunning",
                                        "notification.body.alreadyRunning",
                                        None,
                                        None,
                                        Some(crate::utils::types::logs::LogLevel::Info),
                                    ),
                                    Some(crate::utils::types::origin::Origin::Internal),
                                );
                            }
                        }
                    })
                    .build(),
            );
        }

        #[cfg(not(target_os = "linux"))]
        {
            builder = builder.plugin(
                tauri_plugin_single_instance::Builder::new()
                    .callback(|_app: &tauri::AppHandle, _, _| {
                        #[cfg(feature = "web-server")]
                        info!("Another instance attempted to run.");

                        #[cfg(not(feature = "web-server"))]
                        {
                            // Only show window if it exists, don't try to create
                            // Creating from single instance callback can cause crashes
                            if let Some(window) = _app.get_webview_window("main") {
                                info!("📢 Second instance detected, showing existing window");
                                let _ = window.show();
                                let _ = window.set_focus();
                            } else {
                                info!("📢 Second instance detected, but window was destroyed. Use tray to reopen.");
                                crate::utils::app::notification::send_notification_typed(
                                    _app,
                                    crate::utils::app::notification::Notification::localized(
                                        "notification.title.alreadyRunning",
                                        "notification.body.alreadyRunning",
                                        None,
                                        None,
                                        Some(crate::utils::types::logs::LogLevel::Info),
                                    ),
                                    Some(crate::utils::types::origin::Origin::Internal),
                                );
                            }
                        }
                    })
                    .build(),
            );
        }
    }

    // -------------------------------------------------------------------------
    // Updater Plugin (Desktop + Updater feature)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, feature = "updater"))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    // -------------------------------------------------------------------------
    // Window Events (Desktop only, not web-server)
    // -------------------------------------------------------------------------
    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let app_handle = window.app_handle();

                // Read settings from AppSettingsManager which caches internally
                let (tray_enabled, destroy_on_close) = app_handle
                    .try_state::<core::settings::AppSettingsManager>()
                    .and_then(|manager| {
                        manager
                            .get_all()
                            .ok()
                            .map(|s| (s.general.tray_enabled, s.developer.destroy_window_on_close))
                    })
                    .unwrap_or((false, false));

                if tray_enabled {
                    if destroy_on_close {
                        debug!("♻️ Optimization Enabled: Destroying window to free RAM");
                    } else {
                        #[cfg(desktop)]
                        if let Err(e) = window.hide() {
                            error!("Failed to hide window: {e}");
                        }
                        api.prevent_close();
                    }
                } else {
                    api.prevent_close();
                    let window_ = window.clone();
                    tauri::async_runtime::spawn(async move {
                        window_
                            .app_handle()
                            .state::<RcloneState>()
                            .set_shutting_down();
                        let _ = shutdown_app(window_.app_handle().clone()).await;
                    });
                }
            }
            #[cfg(desktop)]
            WindowEvent::Focused(true) => {
                if let Some(win) = window.app_handle().get_webview_window("main")
                    && let Err(e) = win.show()
                {
                    error!("Failed to show window: {e}");
                }
            }
            _ => {}
        });
    }

    // -------------------------------------------------------------------------
    // Autostart Plugin (Desktop, non-Flatpak)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, not(feature = "flatpak")))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ));
    }

    // -------------------------------------------------------------------------
    // Core Plugins & Setup
    // -------------------------------------------------------------------------
    builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init());

    // Desktop-only plugins (not needed in headless/web-server mode)
    #[cfg(feature = "desktop")]
    {
        builder = builder
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder = builder.setup(move |app| setup_app(app, cli_args.clone()));

    // -------------------------------------------------------------------------
    // Tray Menu Events (Desktop)
    // -------------------------------------------------------------------------
    #[cfg(desktop)]
    {
        builder = builder.on_menu_event(handle_tray_menu_event);
    }

    // -------------------------------------------------------------------------
    // Invoke Handler (Desktop mode only)
    // -------------------------------------------------------------------------
    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.invoke_handler(generate_invoke_handler!());
    }

    // -------------------------------------------------------------------------
    // Build and Run
    // -------------------------------------------------------------------------
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(feature = "web-server")]
    {
        info!("🎯 Tauri event loop starting (Web Server Mode)");
        app.run(|_app_handle, _event| {});
    }

    #[cfg(not(feature = "web-server"))]
    {
        app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app_handle.state::<RcloneState>();
                if !state.is_shutting_down() {
                    api.prevent_exit();

                    #[cfg(target_os = "linux")]
                    {
                        std::thread::spawn(|| {
                            utils::process::process_manager::cleanup_webkit_zombies();
                        });
                    }
                }
            }
        });
    }
}

// =============================================================================
// SETUP FUNCTION
// =============================================================================

fn setup_app(
    app: &mut tauri::App,
    cli_args: crate::core::cli::CliArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle();
    let app_paths = AppPaths::setup(app_handle)?;
    let config_dir = app_paths.config_dir;

    // -------------------------------------------------------------------------
    // Initialize rcman Settings Manager
    // -------------------------------------------------------------------------
    let rcman_manager =
        rcman::SettingsManager::builder(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
            .with_config_dir(&config_dir)
            .with_credentials()
            .with_schema::<AppSettings>()
            .with_migrator(|mut value: serde_json::Value| {
                if let Some(root) = value.as_object_mut()
                    && let Some(app_settings) = root.remove("app_settings")
                {
                        log::info!("found legacy app_settings, flattening to root");
                        if let Some(app_settings_obj) = app_settings.as_object() {
                            for (k, v) in app_settings_obj {
                                if !root.contains_key(k) {
                                    root.insert(k.clone(), v.clone());
                                }
                            }
                        }
                }
                value
            })
            .with_sub_settings(
                rcman::SubSettingsConfig::new("remotes")
                    .with_profiles()
                    .with_migrator(
                        crate::core::settings::remote::manager::migrate_to_multi_profile,
                    ),
            )
            .with_sub_settings(
                rcman::SubSettingsConfig::singlefile("backend")
                    .with_profiles()
                    .with_migrator(|mut value: serde_json::Value| {
                        if let Some(root) = value.as_object_mut()
                            && let Some(backend_settings) = root.remove("backend")
                        {
                            log::info!("found legacy backend settings, flattening to root");
                            if let Some(backend_obj) = backend_settings.as_object() {
                                for (k, v) in backend_obj {
                                    if !root.contains_key(k) {
                                        root.insert(k.clone(), v.clone());
                                    }
                                }
                            }
                        }
                        value
                    }),
            )
            .with_sub_settings(
                rcman::SubSettingsConfig::singlefile("connections")
                    .with_schema::<crate::rclone::backend::schema::BackendConnectionSchema>()
                    .with_migrator(|value: serde_json::Value| {
                        // Secret Migration: Move keys from `backend:{name}:password` to `sub.connections.{name}.password`
                        #[cfg(desktop)]
                        {
                            use rcman::CredentialManager;
                            // Use same service name as main app (env!("CARGO_PKG_NAME"))
                            let service_name = env!("CARGO_PKG_NAME");

                            // We need a temporary CredentialManager to check legacy keys
                            // Since we don't have the instance from outside, we create a new handle to the same service
                            let creds = CredentialManager::new(service_name);

                            if let Some(connections) = value.as_object() {
                                for (name, _) in connections {
                                    // 1. Password field
                                    let legacy_pass_key = format!("backend:{}:password", name);
                                    let new_pass_key = format!("sub.connections.{}.password", name);

                                    // Only migrate if legacy exists AND new one doesn't (don't overwrite new data)
                                    if creds.exists(&legacy_pass_key) {
                                        if !creds.exists(&new_pass_key) {
                                            if let Ok(Some(secret)) = creds.get(&legacy_pass_key) {
                                                log::info!("🔐 Migrating legacy password for '{}'", name);
                                                if let Err(e) = creds.store(&new_pass_key, &secret) {
                                                    log::error!("Failed to migrate password for '{}': {}", name, e);
                                                } else {
                                                    // Only delete legacy if migration succeeded
                                                    let _ = creds.remove(&legacy_pass_key);
                                                }
                                            }
                                        } else {
                                            // New key exists, just clean up legacy
                                            log::debug!("Cleaning up legacy password for '{}' (already migrated)", name);
                                            let _ = creds.remove(&legacy_pass_key);
                                        }
                                    }

                                    // 2. Config Password field
                                    let legacy_conf_key = format!("backend:{}:config_password", name);
                                    let new_conf_key = format!("sub.connections.{}.config_password", name);

                                    if creds.exists(&legacy_conf_key) {
                                        if !creds.exists(&new_conf_key) {
                                            if let Ok(Some(secret)) = creds.get(&legacy_conf_key) {
                                                log::info!("🔐 Migrating legacy config_password for '{}'", name);
                                                if let Err(e) = creds.store(&new_conf_key, &secret) {
                                                    log::error!("Failed to migrate config_password for '{}': {}", name, e);
                                                } else {
                                                    let _ = creds.remove(&legacy_conf_key);
                                                }
                                            }
                                        } else {
                                            log::debug!("Cleaning up legacy config_password for '{}' (already migrated)", name);
                                            let _ = creds.remove(&legacy_conf_key);
                                        }
                                    }
                                }
                            }
                        }
                        value
                    }),
            )
            .build()
            .map_err(|e| format!("Failed to create rcman settings manager: {e}"))?;

    // -------------------------------------------------------------------------
    // Initialize Backend Manager (Core Dependency)
    // -------------------------------------------------------------------------
    use crate::rclone::backend::BackendManager;
    let backend_manager = BackendManager::new();
    app.manage(backend_manager);

    // -------------------------------------------------------------------------
    // Load Settings & Initialize State
    // -------------------------------------------------------------------------

    app.manage(cli_args.clone());

    let settings = rcman_manager
        .get_all()
        .map_err(|e: rcman::Error| format!("Failed to load startup settings: {e}"))?;

    use crate::core::security::SafeEnvironmentManager;
    let env_manager = SafeEnvironmentManager::new();

    if let Err(e) = env_manager.init_with_stored_credentials(&rcman_manager) {
        error!("Failed to initialize environment manager with stored credentials: {e}");
    }

    // -------------------------------------------------------------------------
    // Initialize Backend i18n (before managing rcman_manager)
    // -------------------------------------------------------------------------
    crate::utils::i18n::init(app_paths.resource_dir);

    // Set initial language from settings
    if let Ok(lang) = rcman_manager.get::<String>("general.language") {
        crate::utils::i18n::set_language(&lang);
    }

    // -------------------------------------------------------------------------
    // Manage App State
    // -------------------------------------------------------------------------
    app.manage(tokio::sync::Mutex::new(RcApiEngine::default()));
    app.manage(rcman_manager);
    app.manage(env_manager);

    // Note: Settings like tray_enabled, notifications_enabled, restrict_mode,
    // rclone_path are now read from AppSettingsManager
    app.manage(RcloneState {
        client: reqwest::Client::new(),
        is_shutting_down: AtomicBool::new(false),
        is_restart_required: AtomicBool::new(false),
        is_update_in_progress: AtomicBool::new(false),
        oauth_process: tokio::sync::Mutex::new(None),
    });

    app.manage(LogCache::new(1000));
    app.manage(ScheduledTasksCache::new());
    app.manage(CronScheduler::new());

    // Initialize Updater States
    app.manage(AppUpdaterState::default());
    app.manage(RcloneUpdaterState::default());

    // -------------------------------------------------------------------------
    // Initialize Logging
    // -------------------------------------------------------------------------
    init_logging(&settings.developer.log_level, app_handle.clone())
        .map_err(|e| format!("Failed to initialize logging: {e}"))?;

    // -------------------------------------------------------------------------
    // Async Initialization
    // -------------------------------------------------------------------------
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        initialization(app_handle_clone.clone()).await;
        let force_tray = std::env::args().any(|arg| arg == "--tray");
        if settings.general.tray_enabled || force_tray {
            if force_tray {
                debug!("🧊 Setting up tray (forced by --tray argument)");
            } else {
                debug!("🧊 Setting up tray (enabled in settings)");
            }
            if let Err(e) = utils::app::builder::setup_tray(app_handle_clone.clone()).await {
                error!("Failed to setup tray: {e}");
            }
        }

        handle_startup(app_handle_clone.clone()).await;

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        monitor_network_changes(app_handle_clone).await;
    });

    // -------------------------------------------------------------------------
    // Web Server Startup (web-server mode only)
    // -------------------------------------------------------------------------
    #[cfg(feature = "web-server")]
    {
        use crate::server::start_web_server;

        let web_handle = app.handle().clone();
        let args = cli_args;

        info!(
            "🚀 Initializing Web Server on {}:{}...",
            args.headless.host, args.headless.port
        );
        if args.headless.user.is_some() {
            info!("🔐 Basic authentication enabled");
        }
        if args.headless.tls_cert.is_some() && args.headless.tls_key.is_some() {
            info!("🔒 TLS/HTTPS enabled");
        }

        tauri::async_runtime::spawn(async move {
            if let Err(e) = start_web_server(
                web_handle,
                args.headless.host.clone(),
                args.headless.port,
                args.auth_credentials(),
                args.headless.tls_cert.clone(),
                args.headless.tls_key.clone(),
            )
            .await
            {
                error!("❌ Web server failed to start: {e}");
            }
        });
    }

    // -------------------------------------------------------------------------
    // Window Creation (Desktop, non-web-server)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, not(feature = "web-server")))]
    if !std::env::args().any(|arg| arg == "--tray") {
        debug!("Creating main window");
        create_app_window(app.handle().clone(), None);
    }

    Ok(())
}

// =============================================================================
// TRAY MENU EVENT HANDLER
// =============================================================================

#[cfg(desktop)]
fn handle_tray_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    use crate::rclone::commands::mount::unmount_all_remotes;

    if let Some(action) = TrayAction::from_id(event.id.as_ref()) {
        match action {
            TrayAction::MountProfile(remote, profile) => {
                handle_mount_profile(app.clone(), &remote, &profile)
            }
            TrayAction::UnmountProfile(remote, profile) => {
                handle_unmount_profile(app.clone(), &remote, &profile)
            }
            TrayAction::SyncProfile(remote, profile) => {
                handle_sync_profile(app.clone(), &remote, &profile)
            }
            TrayAction::StopSyncProfile(remote, profile) => {
                handle_stop_sync_profile(app.clone(), &remote, &profile)
            }
            TrayAction::CopyProfile(remote, profile) => {
                handle_copy_profile(app.clone(), &remote, &profile)
            }
            TrayAction::StopCopyProfile(remote, profile) => {
                handle_stop_copy_profile(app.clone(), &remote, &profile)
            }
            TrayAction::MoveProfile(remote, profile) => {
                handle_move_profile(app.clone(), &remote, &profile)
            }
            TrayAction::StopMoveProfile(remote, profile) => {
                handle_stop_move_profile(app.clone(), &remote, &profile)
            }
            TrayAction::BisyncProfile(remote, profile) => {
                handle_bisync_profile(app.clone(), &remote, &profile)
            }
            TrayAction::StopBisyncProfile(remote, profile) => {
                handle_stop_bisync_profile(app.clone(), &remote, &profile)
            }
            TrayAction::ServeProfile(remote, profile) => {
                handle_serve_profile(app.clone(), &remote, &profile)
            }
            TrayAction::StopServeProfile(remote, serve_id) => {
                handle_stop_serve_profile(app.clone(), &remote, &serve_id)
            }
            TrayAction::Browse(_remote) => {
                #[cfg(not(feature = "web-server"))]
                handle_browse_remote(app, &_remote);
            }
            TrayAction::BrowseInApp(remote) => {
                #[cfg(not(feature = "web-server"))]
                core::tray::actions::handle_browse_in_app(app, &remote);
                #[cfg(feature = "web-server")]
                {
                    let args = app.state::<crate::core::cli::CliArgs>();
                    let host = if args.headless.host == "0.0.0.0" {
                        "127.0.0.1"
                    } else {
                        &args.headless.host
                    };
                    let protocol = if args.headless.tls_cert.is_some() {
                        "https"
                    } else {
                        "http"
                    };
                    // Encode the remote name for the query parameter
                    let url = format!(
                        "{}://{}:{}?browse={}",
                        protocol,
                        host,
                        args.headless.port,
                        urlencoding::encode(&remote)
                    );

                    use tauri_plugin_opener::OpenerExt;
                    if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                        log::error!("Failed to open web UI for browsing: {}", e);
                    }
                }
            }
            TrayAction::UnmountAll => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = unmount_all_remotes(app_clone.clone(), "menu".to_string()).await
                    {
                        error!("Failed to unmount all remotes: {e}");
                    }
                });
            }
            TrayAction::StopAllJobs => handle_stop_all_jobs(app.clone()),
            TrayAction::StopAllServes => handle_stop_all_serves(app.clone()),
        }
        return;
    }

    match event.id.as_ref() {
        #[cfg(not(feature = "web-server"))]
        "show_app" => core::tray::actions::show_main_window(app.clone()),
        #[cfg(feature = "web-server")]
        "open_web_ui" => {
            let args = app.state::<crate::core::cli::CliArgs>();
            let host = if args.headless.host == "0.0.0.0" {
                "127.0.0.1"
            } else {
                &args.headless.host
            };
            let protocol = if args.headless.tls_cert.is_some() {
                "https"
            } else {
                "http"
            };
            let url = format!("{}://{}:{}", protocol, host, args.headless.port);

            use tauri_plugin_opener::OpenerExt;
            if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                error!("Failed to open web UI: {}", e);
            }
        }
        "quit" => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                app_clone.state::<RcloneState>().set_shutting_down();
                let _ = shutdown_app(app_clone).await;
            });
        }
        _ => {}
    }
}
