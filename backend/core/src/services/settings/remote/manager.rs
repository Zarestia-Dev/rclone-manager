//! Remote settings management using rcman sub-settings
//!
//! This module handles remote-specific configuration operations using
//! rcman's sub-settings system, which stores each remote's config in
//! `config/remotes/{remoteName}.json`.

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use log::{info, warn};
use serde_json::Value;

use crate::rclone::state::automations::AutomationsCache;
use crate::utils::types::events::REMOTE_SETTINGS_CHANGED;
use crate::utils::types::remotes::OperationType;

/// Replace supplied settings sections while preserving omitted sections.
fn merge_settings(existing: &Value, desired: &Value) -> Result<Value, String> {
    let desired = desired.as_object().ok_or_else(|| crate::localized_error!("backendErrors.settings.saveFailed", "error" => "Invalid settings object"))?;
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    merged.extend(desired.clone());
    Ok(Value::Object(merged))
}

pub async fn save_remote_settings(
    app: AppHandle,
    remote_name: String,
    settings: Value,
    backend_name: Option<String>,
) -> Result<(), String> {
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let _selection = backend_manager.switch_lock.lock().await;
    let backend = backend_manager.get_active().await;
    if backend_name
        .as_ref()
        .is_some_and(|expected| expected != &backend.name)
    {
        return Err(
            crate::localized_error!("backendErrors.request.failed", "error" => "Backend selection changed"),
        );
    }
    let manager = app.state::<AppSettingsManager>();
    let remotes = manager.inner().sub_settings("remotes").map_err(|error| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => error))?;
    let existing = match remotes.get_value(&remote_name) {
        Ok(value) => value,
        Err(error) if error.is_not_found() => serde_json::json!({}),
        Err(error) => {
            return Err(
                crate::localized_error!("backendErrors.settings.saveFailed", "error" => error),
            );
        }
    };
    let mut settings = merge_settings(&existing, &settings)?;
    settings["name"] = Value::String(remote_name.clone());
    settings = migrate_to_multi_profile(settings);
    let parsed: crate::utils::types::remotes::RemoteSettings = serde_json::from_value(settings)
        .map_err(
            |error| crate::localized_error!("backendErrors.settings.saveFailed", "error" => error),
        )?;
    let resolved_settings = serde_json::to_value(&parsed).map_err(
        |error| crate::localized_error!("backendErrors.settings.saveFailed", "error" => error),
    )?;
    // Reject malformed cron before committing the desired settings to disk.
    for operation in OperationType::ALL {
        if let Some(profiles) = parsed.get_configs(*operation) {
            for profile in profiles.values() {
                crate::services::automation::engine::validate_enabled_cron(
                    profile.app.cron_enabled == Some(true),
                    profile.app.cron_expression.as_deref(),
                )?;
                for (name, section) in [
                    (profile.app.vfs_profile.as_deref(), "vfsConfigs"),
                    (profile.app.filter_profile.as_deref(), "filterConfigs"),
                    (profile.app.backend_profile.as_deref(), "backendConfigs"),
                ] {
                    crate::utils::json_helpers::resolve_profile_options(
                        &resolved_settings,
                        name,
                        section,
                    )?;
                }
                crate::rclone::commands::common::resolve_runtime_remote_options(
                    &profile.app,
                    &profile.rclone,
                    &resolved_settings,
                )?;
            }
        }
    }
    remotes.set(&remote_name, &parsed).map_err(
        |error| crate::localized_error!("backendErrors.settings.saveFailed", "error" => error),
    )?;
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_remote(&remote_name);
    }
    let jobs = backend_manager.job_cache_for(&backend.name);
    if let Ok(previous) =
        serde_json::from_value::<crate::utils::types::remotes::RemoteSettings>(existing)
    {
        for operation in OperationType::ALL {
            if let (Some(profiles), Some(job_type)) =
                (previous.get_configs(*operation), operation.as_job_type())
            {
                for name in profiles.keys().filter(|name| {
                    parsed
                        .get_configs(*operation)
                        .is_none_or(|profiles| !profiles.contains_key(*name))
                }) {
                    jobs.delete_jobs_by_profile(&remote_name, name, &job_type, Some(&app))
                        .await;
                }
            }
        }
    }
    let cache = app.state::<AutomationsCache>();
    cache
        .add_or_update_automation_for_remote(&backend.name, &remote_name, &parsed)
        .await?;
    crate::services::bridge::emit(REMOTE_SETTINGS_CHANGED, remote_name);
    crate::services::automation::runtime::refresh(&app).await?;
    crate::services::automation::engine::apply_and_sync_automations(&app).await
}

pub async fn delete_remote_settings(app: AppHandle, remote_name: String) -> Result<(), String> {
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let _selection = backend_manager.switch_lock.lock().await;
    let backend = backend_manager.get_active_name().await;
    delete_remote_settings_on_backend(&app, remote_name, &backend).await
}

/// Caller holds BackendManager::switch_lock to keep the settings profile stable.
pub(crate) async fn delete_remote_settings_on_backend(
    app: &AppHandle,
    remote_name: String,
    backend: &str,
) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    let remotes = manager.inner().sub_settings("remotes").map_err(|error| crate::localized_error!("backendErrors.settings.subSettingsFailed", "error" => error))?;
    match remotes.get_value(&remote_name) {
        Ok(_) => remotes.delete(&remote_name).map_err(|error| crate::localized_error!("backendErrors.settings.deleteFailed", "error" => error))?,
        Err(error) if error.is_not_found() => {},
        Err(error) => return Err(crate::localized_error!("backendErrors.settings.deleteFailed", "error" => error)),
    }
    if let Some(runtime) = app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        runtime.invalidate_remote(&remote_name);
    }
    app.state::<AutomationsCache>()
        .remove_automations_for_remote(backend, &remote_name)
        .await?;
    crate::services::bridge::emit(REMOTE_SETTINGS_CHANGED, remote_name);
    crate::services::automation::runtime::refresh(app).await?;
    crate::services::automation::engine::apply_and_sync_automations(app).await
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
                        "resyncMode",
                        "checkAccess",
                        "checkFilename",
                        "maxDelete",
                        "force",
                        "checkSync",
                        "compare",
                        "conflictLoser",
                        "conflictResolve",
                        "conflictSuffix",
                        "createEmptySrcDirs",
                        "removeEmptyDirs",
                        "downloadHash",
                        "filtersFile",
                        "ignoreListingChecksum",
                        "maxLock",
                        "noSlowHash",
                        "slowHashSyncOnly",
                        "recover",
                        "resilient",
                        "workdir",
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

    // Runtime profiles are scoped maps: { remoteName: { options } }. Preserve
    // existing scoped data; repair the flat form written by older migrations.
    let owner = obj.get("name").and_then(Value::as_str).map(str::to_string);
    if let Some(configs) = obj
        .get_mut("runtimeRemoteConfigs")
        .and_then(Value::as_object_mut)
    {
        for profile in configs.values_mut() {
            if let Some(options) = profile.as_object()
                && options.values().any(|value| !value.is_object())
                && let Some(owner) = &owner
            {
                *profile = serde_json::json!({owner: options});
            }
        }
    }

    // Partition every operation using the canonical registry.
    for operation in OperationType::ALL {
        if let Some(configs) = obj
            .get_mut(operation.config_key())
            .and_then(Value::as_object_mut)
        {
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

    if let Some(rclone_obj) = p_obj.get_mut("rclone").and_then(|v| v.as_object_mut()) {
        rclone_obj.remove("app");
        for &key in crate::utils::types::remotes::APP_PARTITION_KEYS {
            rclone_obj.remove(key);
        }
    }

    if p_obj.contains_key("app") || p_obj.contains_key("rclone") {
        return;
    }

    let mut app_map = serde_json::Map::new();
    let mut rclone_map = serde_json::Map::new();

    for (k, v) in std::mem::take(p_obj) {
        if crate::utils::types::remotes::APP_PARTITION_KEYS.contains(&k.as_str()) {
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

    #[tokio::test]
    async fn invalid_cron_and_dangling_profiles_do_not_overwrite_saved_settings() {
        use crate::rclone::backend::BackendManager;
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager =
            rcman::SettingsManager::builder("settings-contract", "1.0.0")
                .with_config_dir(directory.path())
                .with_schema::<crate::services::settings::schema::AppSettings>()
                .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
                .build()
                .unwrap();
        let original = json!({"name": "drive", "syncConfigs": {"Default": {"app": {}, "rclone": {"srcFs": "/src", "dstFs": "drive:"}}}});
        settings
            .sub_settings("remotes")
            .unwrap()
            .set("drive", &original)
            .unwrap();
        let app = AppHandle::default();
        app.manage(settings);
        app.manage(BackendManager::new());
        for invalid in [
            json!({"cronEnabled": true, "cronExpression": null}),
            json!({"filterProfile": "MissingCustom"}),
        ] {
            let mut update = original.clone();
            update["syncConfigs"]["Default"]["app"] = invalid;
            assert!(
                save_remote_settings(app.clone(), "drive".into(), update, None)
                    .await
                    .is_err()
            );
            let actual = app
                .state::<AppSettingsManager>()
                .sub_settings("remotes")
                .unwrap()
                .get_value("drive")
                .unwrap();
            assert_eq!(actual, original);
        }
    }

    #[test]
    fn saves_replace_supplied_sections_and_preserve_omitted_settings() {
        let stored = json!({
            "name": "drive",
            "serveConfigs": {"Default": {"app": {"autoStart": false, "cronExpression": null}}},
            "filterConfigs": {"Photos": {"include": ["*.jpg"]}}
        });
        let desired = json!({"serveConfigs": {"Default": {
            "app": {}, "rclone": {"fs": "drive:"}
        }}});
        let saved = merge_settings(&stored, &desired).unwrap();
        assert_eq!(saved["serveConfigs"], desired["serveConfigs"]);
        assert_eq!(saved["filterConfigs"], stored["filterConfigs"]);
        assert_eq!(saved["name"], "drive");
        assert_eq!(merge_settings(&saved, &desired).unwrap(), saved);

        let deleted = merge_settings(&saved, &json!({"serveConfigs": {}})).unwrap();
        assert_eq!(deleted["serveConfigs"], json!({}));
        assert_eq!(deleted["filterConfigs"], stored["filterConfigs"]);
        assert!(merge_settings(&saved, &Value::Null).is_err());
        assert!(merge_settings(&saved, &json!([])).is_err());
    }

    #[test]
    fn migration_partitions_every_registered_operation() {
        for operation in OperationType::ALL {
            let key = operation.config_key();
            let settings = json!({key: {"Default": {
                "autoStart": true, "cronEnabled": false, "srcFs": "drive:photos"
            }}});
            let migrated = migrate_to_multi_profile(settings);
            assert_eq!(
                migrated[key]["Default"],
                json!({
                    "app": {"autoStart": true, "cronEnabled": false},
                    "rclone": {"srcFs": "drive:photos"}
                })
            );
            assert_eq!(migrate_to_multi_profile(migrated.clone()), migrated);
        }
    }

    #[test]
    fn runtime_migration_preserves_scoped_form_and_repairs_flat_form_idempotently() {
        for profile in [
            json!({"region":"us", "env_auth":true}),
            json!({"drive":{"region":"us", "env_auth":true}}),
        ] {
            let config = json!({"name":"drive", "runtimeRemoteConfigs":{"Default": profile}});
            let migrated = migrate_to_multi_profile(config);
            assert_eq!(
                migrated["runtimeRemoteConfigs"]["Default"],
                json!({"drive":{"region":"us", "env_auth":true}})
            );
            assert_eq!(migrate_to_multi_profile(migrated.clone()), migrated);
        }
    }

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

        // RuntimeRemote: options flattened and double nesting flattened
        let rt = &obj["runtimeRemoteConfigs"]["default"];
        assert_eq!(rt["Google Drive"]["scope"], "drive.readonly");
        assert!(rt.get("options").is_none());
        assert!(rt.get("Google Drive").is_some());
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

    #[test]
    fn test_migrate_remote_sub_settings_double_nested() {
        let legacy = json!({
            "runtimeRemoteConfigs": {
                "Default": {
                    "One Drive": {
                        "token": "secret_token",
                        "client_credentials": true
                    }
                }
            }
        });

        let migrated = migrate_to_multi_profile(legacy);
        let default_profile = &migrated["runtimeRemoteConfigs"]["Default"];

        assert_eq!(default_profile["One Drive"]["token"], "secret_token");
        assert_eq!(default_profile["One Drive"]["client_credentials"], true);
        assert!(default_profile.get("One Drive").is_some());
    }

    #[test]
    fn test_migrate_remote_sub_settings_already_flat() {
        let flat = json!({
            "runtimeRemoteConfigs": {
                "Default": {
                    "token": "secret_token",
                    "client_credentials": true
                }
            }
        });

        let migrated = migrate_to_multi_profile(flat.clone());
        assert_eq!(migrated, flat);
    }

    #[test]
    fn test_partition_cleans_nested_app_in_rclone() {
        let mut profile = json!({
            "app": {
                "autoStart": true
            },
            "rclone": {
                "app": {
                    "autoStart": false
                },
                "autoStart": false,
                "fs": "OneDrive:Documents",
                "mountPoint": "/home/test/OneDrive"
            }
        });
        partition_profile_to_app_and_rclone(&mut profile);
        let rclone = &profile["rclone"];
        assert!(rclone.get("app").is_none());
        assert!(rclone.get("autoStart").is_none());
        assert_eq!(rclone["fs"], "OneDrive:Documents");
        assert_eq!(rclone["mountPoint"], "/home/test/OneDrive");
    }
}
