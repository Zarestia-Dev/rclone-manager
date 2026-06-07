//! Remote settings management using rcman sub-settings
//!
//! This module handles remote-specific configuration operations using
//! rcman's sub-settings system, which stores each remote's config in
//! `config/remotes/{remoteName}.json`.
//!
//! Migration from legacy formats is handled automatically by rcman's
//! `with_migrator()` feature when loading entries.

use crate::core::settings::AppSettingsManager;
use log::{info, warn};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::rclone::state::automations::AutomationsCache;
use crate::utils::types::events::REMOTE_SETTINGS_CHANGED;
use crate::utils::types::remotes::OperationConfigKey;

/// **Save remote settings (per remote)**
#[tauri::command]
pub async fn save_remote_settings(
    app: AppHandle,
    remote_name: String,
    mut settings: Value,
) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let cache = app.state::<AutomationsCache>();

    // Insert name into settings
    if let Some(settings_obj) = settings.as_object_mut() {
        settings_obj.insert("name".to_string(), Value::String(remote_name.clone()));
    }

    // Get remotes sub-settings
    let remotes = manager.inner().sub_settings("remotes").map_err(
        |e| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => e),
    )?;

    // Fetch existing settings once
    let existing = remotes.get_value(&remote_name).ok();

    // Check if remote already exists and merge settings
    if let Some(existing_obj) = existing.as_ref().and_then(|v| v.as_object())
        && let Some(new_obj) = settings.as_object_mut()
    {
        let mut merged = existing_obj.clone();
        merged.append(new_obj);
        settings = Value::Object(merged);
    }

    // Validate the settings structure and canonicalize it
    let parsed: crate::utils::types::remotes::RemoteSettings = serde_json::from_value(settings)
        .map_err(|e| format!("Invalid remote settings structure: {e}"))?;

    let cleaned_settings = serde_json::to_value(&parsed)
        .map_err(|e| format!("Failed to serialize remote settings: {e}"))?;

    // Save to rcman sub-settings
    remotes
        .set(&remote_name, &cleaned_settings)
        .map_err(|e| crate::localized_error!("backendErrors.settings.saveFailed", "error" => e))?;

    info!("Remote settings saved for '{remote_name}'");

    // Detect deleted profiles
    if let Some(ref existing_val) = existing {
        for config_key in OperationConfigKey::ALL {
            let key = config_key.as_str();
            if let Some(old_configs) = existing_val.get(key).and_then(|v| v.as_object()) {
                let new_configs = cleaned_settings.get(key).and_then(|v| v.as_object());
                for profile_name in old_configs.keys() {
                    let was_deleted = new_configs.is_none_or(|new| !new.contains_key(profile_name));

                    if was_deleted {
                        info!(
                            "Profile '{profile_name}' deleted for remote '{remote_name}', cleaning up jobs..."
                        );
                        app.state::<crate::rclone::backend::BackendManager>()
                            .job_cache
                            .delete_jobs_by_profile(&remote_name, profile_name, Some(&app))
                            .await;
                    }
                }
            }
        }
    }

    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    match cache
        .add_or_update_automation_for_remote(&backend_name, &remote_name, &cleaned_settings)
        .await
    {
        Ok(result) if result.has_changes() => {
            use crate::core::automation::engine::AutomationScheduler;
            let scheduler = app.state::<AutomationScheduler>();
            if let Err(e) = scheduler.apply_cache_result(&result, cache).await {
                warn!("Automation sync incomplete for remote '{remote_name}': {e}");
            } else {
                info!("Automation updated for remote '{remote_name}'");
            }

            let watcher_manager = app.state::<crate::core::automation::watcher::WatcherManager>();
            if let Err(e) = watcher_manager.sync_watchers(app.clone()).await {
                warn!("Watcher sync incomplete for remote '{remote_name}': {e}");
            }
        }
        _ => {}
    }

    app.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
    Ok(())
}

/// **Delete remote settings**
#[tauri::command]
pub async fn delete_remote_settings(app: AppHandle, remote_name: String) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let remotes = manager.inner().sub_settings("remotes").map_err(
        |e| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => e),
    )?;

    if remotes.get_value(&remote_name).is_err() {
        warn!("Remote settings for '{remote_name}' not found, but that's okay.");
        app.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
        return Ok(());
    }

    remotes.delete(&remote_name).map_err(
        |e| crate::localized_error!("backendErrors.settings.deleteFailed", "error" => e),
    )?;

    info!("Remote settings for '{remote_name}' deleted.");
    app.emit(REMOTE_SETTINGS_CHANGED, remote_name).ok();
    Ok(())
}

/// **Retrieve settings for a specific remote**
#[tauri::command]
pub async fn get_remote_settings(
    app: AppHandle,
    remote_name: String,
) -> Result<serde_json::Value, String> {
    let manager = app.state::<AppSettingsManager>();
    let settings =
        crate::utils::types::remotes::RemoteSettings::load(manager.inner(), &remote_name).map_err(
            |_| crate::localized_error!("backendErrors.settings.notFound", "name" => remote_name),
        )?;

    info!("Loaded settings for remote '{remote_name}'.");
    serde_json::to_value(settings).map_err(|e| e.to_string())
}

/// **Get all remote settings as a map (for internal use)**
pub fn get_all_remote_settings_sync(
    manager: &AppSettingsManager,
    remote_names: &[String],
) -> serde_json::Value {
    let all_settings =
        crate::utils::types::remotes::RemoteSettings::load_all(manager, remote_names);
    serde_json::to_value(all_settings).unwrap_or_default()
}

pub fn migrate_to_multi_profile(mut settings: Value) -> Value {
    if let Some(obj) = settings.as_object_mut() {
        let migration_map = [
            ("mountConfig", "mountConfigs"),
            ("syncConfig", "syncConfigs"),
            ("copyConfig", "copyConfigs"),
            ("moveConfig", "moveConfigs"),
            ("bisyncConfig", "bisyncConfigs"),
            ("serveConfig", "serveConfigs"),
            ("filterConfig", "filterConfigs"),
            ("backendConfig", "backendConfigs"),
            ("vfsConfig", "vfsConfigs"),
        ];

        for (old_key, new_key) in migration_map {
            if let Some(mut old_config) = obj.remove(old_key) {
                if obj.contains_key(new_key) {
                    warn!("Removed legacy {old_key} as {new_key} already exists");
                } else {
                    let profile_name = old_config
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Default")
                        .to_string();

                    if let Some(config_obj) = old_config.as_object_mut() {
                        config_obj.remove("name");
                    }

                    let mut profiles_obj = serde_json::Map::new();
                    profiles_obj.insert(profile_name.clone(), old_config);
                    obj.insert(new_key.to_string(), Value::Object(profiles_obj));

                    info!("Migrated legacy {old_key} to {new_key} (profile: '{profile_name}')");
                }
            }
        }

        migrate_profiles_format(obj);
    }
    settings
}

fn promote_options(profile: &mut serde_json::Map<String, Value>, keys: &[&str]) {
    if let Some(mut options) = profile.remove("options")
        && let Some(opts_obj) = options.as_object_mut()
    {
        for &key in keys {
            if let Some(val) = opts_obj.remove(key) {
                profile.insert(key.to_string(), val);
            }
        }
        if !opts_obj.is_empty() {
            profile.insert("_config".to_string(), Value::Object(opts_obj.clone()));
        }
    }
}

fn migrate_profiles_format(obj: &mut serde_json::Map<String, Value>) {
    // 1. Sync, Copy, Move
    for config_key in &["syncConfigs", "copyConfigs", "moveConfigs"] {
        if let Some(configs) = obj.get_mut(*config_key).and_then(|v| v.as_object_mut()) {
            for profile in configs.values_mut() {
                if let Some(p_obj) = profile.as_object_mut() {
                    if p_obj.contains_key("app") || p_obj.contains_key("rclone") {
                        continue;
                    }
                    if let Some(source) = p_obj.remove("source") {
                        let src_val = match source {
                            Value::Array(arr) if arr.len() == 1 => arr[0].clone(),
                            other => other,
                        };
                        p_obj.insert("srcFs".to_string(), src_val);
                    }
                    if let Some(dest) = p_obj.remove("dest") {
                        p_obj.insert("dstFs".to_string(), dest);
                    }
                    promote_options(p_obj, &["createEmptySrcDirs", "deleteEmptySrcDirs"]);
                }
            }
        }
    }

    // 2. Bisync
    if let Some(configs) = obj.get_mut("bisyncConfigs").and_then(|v| v.as_object_mut()) {
        for profile in configs.values_mut() {
            if let Some(p_obj) = profile.as_object_mut() {
                if p_obj.contains_key("app") || p_obj.contains_key("rclone") {
                    continue;
                }
                if let Some(source) = p_obj.remove("source") {
                    p_obj.insert("path1".to_string(), source);
                }
                if let Some(dest) = p_obj.remove("dest") {
                    p_obj.insert("path2".to_string(), dest);
                }
                promote_options(
                    p_obj,
                    &[
                        "dryRun",
                        "resync",
                        "checkAccess",
                        "checkFilename",
                        "maxDelete",
                        "force",
                        "checkSync",
                        "createEmptySrcDirs",
                        "removeEmptyDirs",
                        "filtersFile",
                        "ignoreListingChecksum",
                        "resilient",
                        "workDir",
                        "backupDir1",
                        "backupDir2",
                        "noCleanup",
                    ],
                );
            }
        }
    }

    // 3. Mount
    if let Some(configs) = obj.get_mut("mountConfigs").and_then(|v| v.as_object_mut()) {
        for profile in configs.values_mut() {
            if let Some(p_obj) = profile.as_object_mut() {
                if p_obj.contains_key("app") || p_obj.contains_key("rclone") {
                    continue;
                }
                if let Some(source) = p_obj.remove("source") {
                    p_obj.insert("fs".to_string(), source);
                }
                if let Some(dest) = p_obj.remove("dest") {
                    p_obj.insert("mountPoint".to_string(), dest);
                }
                if let Some(t) = p_obj.remove("type") {
                    p_obj.insert("mountType".to_string(), t);
                }
                if let Some(options) = p_obj.remove("options") {
                    p_obj.insert("mountOpt".to_string(), options);
                }
            }
        }
    }

    // 4. Serve
    if let Some(configs) = obj.get_mut("serveConfigs").and_then(|v| v.as_object_mut()) {
        for profile in configs.values_mut() {
            if let Some(p_obj) = profile.as_object_mut() {
                if p_obj.contains_key("app") || p_obj.contains_key("rclone") {
                    continue;
                }
                if let Some(source) = p_obj.remove("source") {
                    p_obj.insert("fs".to_string(), source);
                }
                if let Some(t) = p_obj.remove("serveType") {
                    p_obj.insert("type".to_string(), t);
                }
                if let Some(mut options) = p_obj.remove("options")
                    && let Some(opts_obj) = options.as_object_mut()
                {
                    if let Some(fs_val) = opts_obj.remove("fs")
                        && !p_obj.contains_key("fs")
                    {
                        p_obj.insert("fs".to_string(), fs_val);
                    }
                    if let Some(type_val) = opts_obj.remove("type")
                        && !p_obj.contains_key("type")
                    {
                        p_obj.insert("type".to_string(), type_val);
                    }
                    if !opts_obj.is_empty() {
                        p_obj.insert("_config".to_string(), Value::Object(opts_obj.clone()));
                    }
                }
            }
        }
    }

    // 5. VFS, Filter, Backend, and Runtime Remote (Helper profiles)
    for configs_key in &[
        "vfsConfigs",
        "filterConfigs",
        "backendConfigs",
        "runtimeRemoteConfigs",
    ] {
        if let Some(configs) = obj.get_mut(*configs_key).and_then(|v| v.as_object_mut()) {
            for profile in configs.values_mut() {
                if let Some(p_obj) = profile.as_object_mut()
                    && let Some(options) = p_obj.remove("options")
                    && let Some(opts_obj) = options.as_object()
                {
                    for (k, v) in opts_obj {
                        p_obj.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }

    // 6. Partition operational profiles to {"app": ..., "rclone": ...}
    for config_key in &[
        "syncConfigs",
        "copyConfigs",
        "moveConfigs",
        "bisyncConfigs",
        "mountConfigs",
        "serveConfigs",
    ] {
        if let Some(configs) = obj.get_mut(*config_key).and_then(|v| v.as_object_mut()) {
            for profile in configs.values_mut() {
                partition_profile_to_app_and_rclone(profile);
            }
        }
    }
}

fn partition_profile_to_app_and_rclone(profile: &mut Value) {
    let Some(p_obj) = profile.as_object_mut() else {
        return;
    };

    if p_obj.contains_key("app") || p_obj.contains_key("rclone") {
        return;
    }

    let app_keys = [
        "autoStart",
        "cronEnabled",
        "cronExpression",
        "watchEnabled",
        "watchDelay",
        "vfsProfile",
        "filterProfile",
        "backendProfile",
        "runtimeRemoteProfile",
    ];

    let mut app_map = serde_json::Map::new();
    let mut rclone_map = serde_json::Map::new();

    for (k, v) in std::mem::take(p_obj) {
        if app_keys.contains(&k.as_str()) {
            app_map.insert(k, v);
        } else {
            rclone_map.insert(k, v);
        }
    }

    p_obj.insert("app".to_string(), Value::Object(app_map));
    p_obj.insert("rclone".to_string(), Value::Object(rclone_map));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Production format from the released version
    fn production_config() -> Value {
        json!({
            "name": "Google Drive",
            "serveConfigs": {
                "default": {
                    "autoStart": true,
                    "backendProfile": "default",
                    "cronEnabled": false,
                    "cronExpression": null,
                    "filterProfile": "default",
                    "options": {
                        "fs": "Google Drive:",
                        "type": "dlna"
                    },
                    "runtimeRemoteProfile": "default",
                    "source": "Google Drive:",
                    "vfsProfile": "default"
                }
            },
            "syncConfigs": {
                "default": {
                    "autoStart": false,
                    "backendProfile": "default",
                    "cronEnabled": true,
                    "cronExpression": "0 18 * * *",
                    "dest": "/home/test/Documents",
                    "filterProfile": "default",
                    "options": {
                        "CheckSum": true,
                        "Checkers": 11,
                        "Transfers": 8,
                        "createEmptySrcDirs": true
                    },
                    "runtimeRemoteProfile": "default",
                    "source": ["Google Drive:"],
                    "vfsProfile": "default"
                }
            },
            "mountConfigs": {
                "default": {
                    "autoStart": false,
                    "backendProfile": "default",
                    "dest": "/home/test/Documents/34467",
                    "filterProfile": "default",
                    "options": {
                        "AttrTimeout": 100044000000_i64,
                    },
                    "runtimeRemoteProfile": "default",
                    "source": "Google Drive:",
                    "type": "mount2",
                    "vfsProfile": "default"
                }
            },
            "vfsConfigs": {
                "default": {
                    "options": {
                        "CacheMode": "full",
                        "NoChecksum": true,
                    }
                }
            },
            "runtimeRemoteConfigs": {
                "default": {
                    "options": {
                        "Google Drive": {
                            "scope": "drive.readonly"
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn test_migrate_from_production_format() {
        let result = migrate_to_multi_profile(production_config());
        let obj = result.as_object().unwrap();

        // Serve: fs extracted from options, type extracted from options, no duplication in _config
        let serve = &obj["serveConfigs"]["default"];
        let rclone = &serve["rclone"];
        assert_eq!(rclone["fs"], "Google Drive:");
        assert_eq!(rclone["type"], "dlna");
        // _config should NOT exist (fs and type were the only options)
        assert!(
            rclone.get("_config").is_none(),
            "serve _config should be empty/absent, got: {:?}",
            rclone.get("_config")
        );

        let app = &serve["app"];
        assert_eq!(app["autoStart"], true);
        assert_eq!(app["backendProfile"], "default");

        // Sync: source -> srcFs, dest -> dstFs, createEmptySrcDirs flattened
        let sync = &obj["syncConfigs"]["default"];
        let rclone = &sync["rclone"];
        assert_eq!(rclone["srcFs"], "Google Drive:");
        assert_eq!(rclone["dstFs"], "/home/test/Documents");
        assert_eq!(rclone["createEmptySrcDirs"], true);
        // Remaining options go to _config
        assert!(rclone["_config"]["CheckSum"].as_bool().unwrap());

        let app = &sync["app"];
        assert_eq!(app["cronEnabled"], true);
        assert_eq!(app["cronExpression"], "0 18 * * *");

        // Mount: source -> fs, dest -> mountPoint, type -> mountType, options -> mountOpt
        let mount = &obj["mountConfigs"]["default"];
        let rclone = &mount["rclone"];
        assert_eq!(rclone["fs"], "Google Drive:");
        assert_eq!(rclone["mountPoint"], "/home/test/Documents/34467");
        assert_eq!(rclone["mountType"], "mount2");
        assert!(rclone["mountOpt"].is_object());

        // VFS: options flattened
        let vfs = &obj["vfsConfigs"]["default"];
        assert_eq!(vfs["CacheMode"], "full");
        assert!(vfs.get("options").is_none());

        // RuntimeRemote: options flattened
        let rt = &obj["runtimeRemoteConfigs"]["default"];
        assert!(rt["Google Drive"].is_object());
        assert!(rt.get("options").is_none());
    }

    #[test]
    fn test_migration_is_idempotent() {
        let first = migrate_to_multi_profile(production_config());
        let second = migrate_to_multi_profile(first.clone());
        assert_eq!(first, second, "Migration should be idempotent");
    }

    #[test]
    fn test_migrate_bisync_copy_move_configs() {
        let input = json!({
            "name": "Extended Remotes",
            "bisyncConfigs": {
                "default": {
                    "autoStart": false,
                    "source": "remote:path1",
                    "dest": "remote:path2",
                    "options": {
                        "dryRun": true,
                        "resync": true,
                        "checkAccess": false,
                        "maxDelete": 50,
                        "customFlag": "hello"
                    }
                }
            },
            "copyConfigs": {
                "default": {
                    "autoStart": true,
                    "source": ["remote:src"],
                    "dest": "remote:dst",
                    "options": {
                        "createEmptySrcDirs": true,
                        "customCopyFlag": 123
                    }
                }
            },
            "moveConfigs": {
                "default": {
                    "autoStart": false,
                    "source": "remote:src",
                    "dest": "remote:dst",
                    "options": {
                        "deleteEmptySrcDirs": true
                    }
                }
            }
        });

        let result = migrate_to_multi_profile(input);
        let obj = result.as_object().unwrap();

        // 1. Bisync
        let bisync = &obj["bisyncConfigs"]["default"];
        let rclone = &bisync["rclone"];
        assert_eq!(rclone["path1"], "remote:path1");
        assert_eq!(rclone["path2"], "remote:path2");
        assert_eq!(rclone["dryRun"], true);
        assert_eq!(rclone["resync"], true);
        assert_eq!(rclone["maxDelete"], 50);
        assert_eq!(rclone["_config"]["customFlag"], "hello");
        // dryRun, resync, checkAccess, maxDelete should NOT be in _config
        assert!(rclone["_config"].get("dryRun").is_none());

        let app = &bisync["app"];
        assert_eq!(app["autoStart"], false);

        // 2. Copy
        let copy = &obj["copyConfigs"]["default"];
        let rclone_copy = &copy["rclone"];
        assert_eq!(rclone_copy["srcFs"], "remote:src");
        assert_eq!(rclone_copy["dstFs"], "remote:dst");
        assert_eq!(rclone_copy["createEmptySrcDirs"], true);
        assert_eq!(rclone_copy["_config"]["customCopyFlag"], 123);

        let app_copy = &copy["app"];
        assert_eq!(app_copy["autoStart"], true);

        // 3. Move
        let move_config = &obj["moveConfigs"]["default"];
        let rclone_move = &move_config["rclone"];
        assert_eq!(rclone_move["srcFs"], "remote:src");
        assert_eq!(rclone_move["dstFs"], "remote:dst");
        assert_eq!(rclone_move["deleteEmptySrcDirs"], true);
    }

    #[test]
    fn test_migrate_edge_cases() {
        let input = json!({
            "name": "Edge Cases",
            "syncConfigs": {
                "empty": {},
                "only_app": {
                    "autoStart": true,
                    "cronEnabled": true
                },
                "unknown_keys": {
                    "someCustomFlag": "val",
                    "options": {
                        "nestedFlag": 456
                    }
                }
            }
        });

        let result = migrate_to_multi_profile(input);
        let obj = result.as_object().unwrap();

        // 1. Empty profile
        let empty = &obj["syncConfigs"]["empty"];
        assert!(empty["app"].as_object().unwrap().is_empty());
        assert!(empty["rclone"].as_object().unwrap().is_empty());

        // 2. Profile with only app keys (autoStart, cronEnabled)
        let only_app = &obj["syncConfigs"]["only_app"];
        let app = &only_app["app"];
        assert_eq!(app["autoStart"], true);
        assert_eq!(app["cronEnabled"], true);
        // rclone should exist but be empty
        let rclone = &only_app["rclone"];
        assert!(rclone.as_object().unwrap().is_empty());

        // 3. Unknown keys
        let unknown = &obj["syncConfigs"]["unknown_keys"];
        let rclone_unknown = &unknown["rclone"];
        assert_eq!(rclone_unknown["someCustomFlag"], "val");
        assert_eq!(rclone_unknown["_config"]["nestedFlag"], 456);
    }
}
