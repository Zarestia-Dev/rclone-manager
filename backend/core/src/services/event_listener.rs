use crate::context::AppHandle;
#[cfg(unix)]
use log::warn;
use log::{debug, error, info};
use serde_json::Value;

use crate::utils::spawn;
use crate::{
    rclone::{backend::BackendManager, commands::system::bandwidth_limit},
    services::{
        automation::commands::reload_automations_from_configs, bridge::event::BridgeEvent,
        lifecycle::shutdown::shutdown_app,
    },
    utils::{
        logging::log::update_log_level,
        types::{
            events::{
                JOB_CACHE_CHANGED, JobChangeEvent, RCLONE_PASSWORD_STORED, REMOTE_CACHE_CHANGED,
                SYSTEM_SETTINGS_CHANGED, SettingsChangeEvent,
            },
            state::EngineState,
        },
    },
};

#[cfg(any(
    feature = "tray",
    target_os = "android",
    all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    )
))]
use crate::utils::types::events::{MOUNT_STATE_CHANGED, SERVE_STATE_CHANGED};

#[cfg(feature = "tray")]
use crate::utils::types::events::{
    BACKEND_SWITCHED, REMOTE_SETTINGS_CHANGED, UPDATE_TRAY_MENU, VAULT_STATE_CHANGED,
    WORKFLOW_EXECUTION_STATE_CHANGED,
};

fn handle_termination_signals(app: &AppHandle) {
    let app_clone = app.clone();
    spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let mut sigterm = signal(SignalKind::terminate()).ok();
            if sigterm.is_none() {
                warn!("Failed to register SIGTERM handler");
            }
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    info!("Ctrl+C / SIGINT received, initiating shutdown");
                }
                _ = async {
                    if let Some(ref mut sig) = sigterm {
                        sig.recv().await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {
                    info!("SIGTERM received, initiating graceful shutdown");
                }
            }
        }

        #[cfg(not(unix))]
        {
            if let Err(e) = tokio::signal::ctrl_c().await {
                error!("Failed to install Ctrl+C handler: {e}");
                return;
            }
            info!("Ctrl+C received, initiating shutdown");
        }

        let _ = shutdown_app(app_clone.clone()).await;
        app_clone.exit(0);
    });
}

fn handle_rclone_password_stored(app: &AppHandle) {
    let app = app.clone();
    spawn(async move {
        let state = app.state::<EngineState>();
        let mut engine = state.lock().await;
        engine.clear_errors();
        engine.init(&app).await;
    });
}

fn handle_remote_presence_changed(app: &AppHandle, payload: &Value) {
    if payload.as_str() == Some("system_refresh")
        || payload.as_str() == Some(crate::utils::constants::CACHE_UPDATED)
    {
        return;
    }
    let app = app.clone();
    spawn(async move {
        let manager = app.state::<BackendManager>();
        let backend = manager.get_active().await;
        let cache = manager.remote_cache_for(&backend.name);

        if let Err(e) = cache
            .refresh_remotes_and_configs(app.clone(), &backend)
            .await
        {
            error!("Failed to refresh cache: {e}");
        }

        if let Err(e) = reload_automations_from_configs(&app).await {
            error!("Failed to reload automations after remote change: {e}");
        }

        #[cfg(feature = "tray")]
        app.host().update_tray();
    });
}

fn handle_settings_changed(app: &AppHandle, payload: &Value) {
    debug!("Settings saved. Payload: {:?}", payload);

    match serde_json::from_value::<SettingsChangeEvent>(payload.clone()) {
        Ok(change) => match (change.category.as_str(), change.key.as_str()) {
            #[cfg(feature = "notifications")]
            ("general", "notifications") => {
                if let Some(enabled) = change.value.as_bool() {
                    handle_notifications_change(app, enabled);
                }
            }
            #[cfg(any(feature = "autostart", all(target_os = "linux", feature = "flatpak")))]
            ("general", "start_on_startup") => {
                if let Some(startup) = change.value.as_bool() {
                    app.host().set_autostart(startup);
                }
            }
            #[cfg(target_os = "android")]
            ("general", "keep_alive" | "start_on_boot") => {
                crate::services::lifecycle::keep_alive::request_sync(app);
            }
            #[cfg(feature = "tray")]
            ("general", "tray_enabled") => {
                if let Some(enabled) = change.value.as_bool() {
                    app.host().set_tray_visible(enabled);
                }
            }
            #[cfg(feature = "tray")]
            ("general", "tray_icon_theme") => {
                app.host().update_tray();
            }
            ("general", "restrict") => {
                if let Some(restrict) = change.value.as_bool() {
                    handle_restrict_mode_change(restrict);
                }
            }
            ("general", "language") => {
                if let Some(lang) = change.value.as_str() {
                    crate::utils::i18n::apply_language_change(lang);
                }
            }
            #[cfg(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))]
            ("general", "prevent_sleep") => {
                let app_clone = app.clone();
                spawn(async move {
                    crate::services::power::update_power_inhibition(&app_clone).await;
                });
            }
            ("core", "bandwidth_limit") => {
                handle_bandwidth_limit_change(app, &change.value);
            }
            ("core", "rclone_binary") => {
                if let Some(path) = change.value.as_str() {
                    handle_rclone_binary_change(app, path);
                }
            }
            ("core", "rclone_additional_flags") => {
                if let Some(flags) = change.value.as_array() {
                    handle_rclone_flags_change(app, flags);
                }
            }
            #[cfg(feature = "tray")]
            ("core", "max_tray_items") => {
                if let Some(max) = change.value.as_u64() {
                    debug!("Max tray items changed to: {max}");
                    app.host().update_tray();
                }
            }
            ("developer", "log_level") => {
                if let Some(level) = change.value.as_str() {
                    debug!("Log level changed to: {level}");
                    update_log_level(level);
                }
            }
            ("developer", "destroy_window_on_close") => {
                if let Some(destroy) = change.value.as_bool() {
                    debug!("Destroy window on close changed to: {destroy}");
                }
            }
            _ => debug!(
                "Unhandled setting change: {}.{}",
                change.category, change.key
            ),
        },
        Err(e) => error!("Failed to parse settings change: {e}"),
    }
}

#[cfg(feature = "notifications")]
fn handle_notifications_change(app: &AppHandle, enabled: bool) {
    debug!("Notifications changed to: {enabled}");
    let app = app.clone();
    spawn(async move {
        use crate::services::alerts::cache;

        let manager = app.state::<crate::services::settings::AppSettingsManager>();
        let mut updated = false;

        if cache::get_action(&manager, "default-os-toast").is_none()
            || cache::get_rule(&manager, "default-rule").is_none()
        {
            let _ = crate::services::alerts::seed::seed_defaults(&manager);
            updated = true;
        }

        if let Some(mut action) = cache::get_action(&manager, "default-os-toast")
            && action.is_enabled() != enabled
        {
            action.set_enabled(enabled);
            let _ = cache::upsert_action(&manager, action);
            updated = true;
        }

        if let Some(mut rule) = cache::get_rule(&manager, "default-rule")
            && rule.enabled != enabled
        {
            rule.enabled = enabled;
            let _ = cache::upsert_rule(&manager, rule);
            updated = true;
        }

        if updated {
            let alert_cache = app.state::<cache::AlertRuleCache>();
            alert_cache.reload_actions(&manager).await;
            alert_cache.reload_rules(&manager).await;

            crate::services::bridge::emit(
                SYSTEM_SETTINGS_CHANGED,
                SettingsChangeEvent {
                    category: "alerts".to_string(),
                    key: "*".to_string(),
                    value: serde_json::Value::Null,
                },
            );
        }
    });
}

fn handle_restrict_mode_change(enabled: bool) {
    debug!("Restrict mode changed to: {enabled}");
    crate::services::bridge::emit(REMOTE_CACHE_CHANGED, "restrict_mode_changed");
}

fn handle_bandwidth_limit_change(app: &AppHandle, value: &Value) {
    debug!("Bandwidth limit changed to: {value}");
    let app = app.clone();
    let limit = parse_setting_bandwidth_limit(value);

    spawn(async move {
        if let Err(e) = bandwidth_limit(app, Some(limit)).await {
            error!("Failed to set bandwidth limit: {e:?}");
        }
    });
}

pub(crate) fn parse_setting_bandwidth_limit(value: &Value) -> String {
    value
        .as_str()
        .map(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                "off".to_string()
            } else {
                trimmed.to_string()
            }
        })
        .or_else(|| value.as_u64().map(|n| n.to_string()))
        .unwrap_or_else(|| "off".to_string())
}

fn handle_rclone_binary_change(app: &AppHandle, path: &str) {
    debug!("Rclone binary changed to: {path}");
    crate::rclone::engine::lifecycle::restart_for_config_change(app, "rclone_binary");
    info!("Rclone binary updated to: {path}");
}

fn handle_rclone_flags_change(app: &AppHandle, flags: &[Value]) {
    debug!("Rclone additional flags changed to: {flags:?}");
    crate::rclone::engine::lifecycle::restart_for_config_change(app, "rclone_additional_flags");
    info!("Engine restarting due to additional flags change");
}

fn handle_job_cache_changed(app: &AppHandle, payload: &Value) {
    let app = app.clone();
    let payload = payload.clone();

    spawn(async move {
        if let Ok(ev) = serde_json::from_value::<JobChangeEvent>(payload)
            && let Ok(id) = ev.job_id.parse::<u64>()
            && let Some(job) = app
                .state::<BackendManager>()
                .job_cache_for(&ev.backend_name)
                .get_job(id)
                .await
        {
            #[cfg(feature = "tray")]
            if job.job_type.is_tray_relevant() {
                app.host().update_tray();
            }

            if job.status.is_finished() {
                crate::services::flow::workflow::engine::trigger_workflows_for_job_finish(
                    &app, &job,
                )
                .await;
            }

            #[cfg(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))]
            crate::services::power::update_power_inhibition(&app).await;
        }
    });
}

fn dispatch_bridge_event(app: &AppHandle, event: &BridgeEvent) {
    match event.event.as_str() {
        RCLONE_PASSWORD_STORED => {
            handle_rclone_password_stored(app);
        }
        REMOTE_CACHE_CHANGED => {
            handle_remote_presence_changed(app, &event.payload);
        }
        SYSTEM_SETTINGS_CHANGED => {
            handle_settings_changed(app, &event.payload);
        }
        JOB_CACHE_CHANGED => {
            handle_job_cache_changed(app, &event.payload);
        }
        #[cfg(feature = "tray")]
        SERVE_STATE_CHANGED
        | MOUNT_STATE_CHANGED
        | BACKEND_SWITCHED
        | REMOTE_SETTINGS_CHANGED
        | WORKFLOW_EXECUTION_STATE_CHANGED
        | VAULT_STATE_CHANGED
        | UPDATE_TRAY_MENU => {
            app.host().update_tray();
        }
        _ => {}
    }

    #[cfg(target_os = "android")]
    if matches!(
        event.event.as_str(),
        JOB_CACHE_CHANGED | MOUNT_STATE_CHANGED | SERVE_STATE_CHANGED
    ) {
        crate::services::lifecycle::keep_alive::request_sync(app);
    }

    #[cfg(target_os = "android")]
    if event.event == MOUNT_STATE_CHANGED {
        let app = app.clone();
        spawn(async move {
            let mounts = app
                .state::<BackendManager>()
                .remote_cache_for(crate::utils::constants::LOCAL_BACKEND_NAME)
                .get_mounted_remotes()
                .await;
            // Also notifies the documents provider that its roots changed.
            crate::rclone::backend::saf_bridge::update_mounted_remotes(&mounts);
        });
    }

    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    if event.event == SERVE_STATE_CHANGED || event.event == MOUNT_STATE_CHANGED {
        let app_clone = app.clone();
        spawn(async move {
            crate::services::power::update_power_inhibition(&app_clone).await;
        });
    }
}

static EVENT_LISTENER_INITIALIZED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn setup_event_listener(app: &AppHandle) {
    if EVENT_LISTENER_INITIALIZED.load(std::sync::atomic::Ordering::Acquire) {
        debug!("Event listener already initialized, skipping duplicate registration");
        return;
    }

    let Some(mut rx) = crate::services::bridge::subscribe() else {
        error!("Failed to subscribe to EventBridge: bridge not initialized");
        return;
    };

    if EVENT_LISTENER_INITIALIZED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }

    handle_termination_signals(app);
    let app = app.clone();
    spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    dispatch_bridge_event(&app, &event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    debug!("Event listener lagged behind, skipped {skipped} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    debug!("EventBridge closed, terminating listener loop");
                    break;
                }
            }
        }
    });

    debug!("Event listeners set up");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_setting_bandwidth_limit() {
        assert_eq!(parse_setting_bandwidth_limit(&json!("")), "off");
        assert_eq!(parse_setting_bandwidth_limit(&json!("   ")), "off");
        assert_eq!(parse_setting_bandwidth_limit(&json!("off")), "off");
        assert_eq!(parse_setting_bandwidth_limit(&json!(null)), "off");
        assert_eq!(parse_setting_bandwidth_limit(&json!("10M")), "10M");
        assert_eq!(parse_setting_bandwidth_limit(&json!(5000)), "5000");
    }

    #[cfg(feature = "tray")]
    mod tray {
        use super::*;
        use crate::context::{Host, ProductInfo};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        #[derive(Default)]
        struct TrayHost {
            updates: AtomicUsize,
            visibility: parking_lot::Mutex<Vec<bool>>,
        }

        #[async_trait::async_trait]
        impl Host for TrayHost {
            fn resolve_paths(
                &self,
                _app: &AppHandle,
            ) -> Result<crate::services::paths::AppPaths, String> {
                Err("not used by tray events".into())
            }

            fn restart(&self, _app: &AppHandle) -> Result<(), String> {
                Err("not used by tray events".into())
            }

            fn update_tray(&self) {
                self.updates.fetch_add(1, Ordering::Relaxed);
            }

            fn set_tray_visible(&self, enabled: bool) {
                self.visibility.lock().push(enabled);
            }
        }

        #[test]
        fn refresh_events_update_the_host_and_unknown_events_are_ignored() {
            let host = Arc::new(TrayHost::default());
            let app = AppHandle::new(host.clone(), ProductInfo::default());
            dispatch_bridge_event(
                &app,
                &BridgeEvent {
                    event: UPDATE_TRAY_MENU.into(),
                    payload: Value::Null,
                },
            );
            dispatch_bridge_event(
                &app,
                &BridgeEvent {
                    event: BACKEND_SWITCHED.into(),
                    payload: json!("NAS & 旅行"),
                },
            );
            dispatch_bridge_event(
                &app,
                &BridgeEvent {
                    event: "unknown event & 旅行".into(),
                    payload: Value::Null,
                },
            );
            assert_eq!(host.updates.load(Ordering::Relaxed), 2);
            assert!(host.visibility.lock().is_empty());
        }

        #[test]
        fn valid_settings_apply_visibility_and_refresh_the_tray() {
            let host = Arc::new(TrayHost::default());
            let app = AppHandle::new(host.clone(), ProductInfo::default());
            for enabled in [true, false] {
                dispatch_bridge_event(
                    &app,
                    &BridgeEvent {
                        event: SYSTEM_SETTINGS_CHANGED.into(),
                        payload: json!({"category": "general", "key": "tray_enabled", "value": enabled}),
                    },
                );
            }
            for (category, key, value) in [
                ("general", "tray_icon_theme", json!("dark")),
                ("core", "max_tray_items", json!(0)),
                ("core", "max_tray_items", json!(20)),
            ] {
                dispatch_bridge_event(
                    &app,
                    &BridgeEvent {
                        event: SYSTEM_SETTINGS_CHANGED.into(),
                        payload: json!({"category": category, "key": key, "value": value}),
                    },
                );
            }
            assert_eq!(*host.visibility.lock(), vec![true, false]);
            assert_eq!(host.updates.load(Ordering::Relaxed), 3);
        }

        #[test]
        fn invalid_or_unrelated_settings_do_not_call_tray_host_methods() {
            let host = Arc::new(TrayHost::default());
            let app = AppHandle::new(host.clone(), ProductInfo::default());
            for payload in [
                Value::Null,
                json!({}),
                json!([]),
                json!({"category": "general", "key": "tray_enabled", "value": "true"}),
                json!({"category": "general", "key": "tray_enabled", "value": null}),
                json!({"category": "core", "key": "max_tray_items", "value": -1}),
                json!({"category": "core", "key": "max_tray_items", "value": 1.5}),
                json!({"category": "core", "key": "max_tray_items", "value": "20"}),
                json!({"category": "unrelated", "key": "tray_enabled", "value": true}),
            ] {
                dispatch_bridge_event(
                    &app,
                    &BridgeEvent {
                        event: SYSTEM_SETTINGS_CHANGED.into(),
                        payload,
                    },
                );
            }
            assert!(host.visibility.lock().is_empty());
            assert_eq!(host.updates.load(Ordering::Relaxed), 0);
        }
    }
}
