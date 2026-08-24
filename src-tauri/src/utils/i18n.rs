//! Internationalization helpers for backend
//!
//! This module provides:
//! 1. Macros to create localized error/success messages for frontend translation
//! 2. Runtime translation resolver for tray menu and notifications (dynamically loaded)

use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::{AppHandle, Emitter};

/// Directory where backend translation files are stored (relative to executable)
const I18N_DIR: &str = "i18n";
pub const DEFAULT_LANG: &str = "en-US";

/// Global translations state
static TRANSLATIONS: Lazy<Translations> = Lazy::new(Translations::new);

struct Translations {
    current_lang: RwLock<String>,
    cache: RwLock<HashMap<String, Value>>,
    base_path: RwLock<Option<PathBuf>>,
}

impl Translations {
    fn new() -> Self {
        Self {
            current_lang: RwLock::new(DEFAULT_LANG.to_string()),
            cache: RwLock::new(HashMap::new()),
            base_path: RwLock::new(None),
        }
    }

    /// Initialize the translations with the base path to the i18n directory
    fn init(&self, resource_dir: PathBuf) {
        let i18n_path = resource_dir.join(I18N_DIR);
        match self.base_path.write() {
            Ok(mut path) => {
                *path = Some(i18n_path.clone());
            }
            Err(_) => log::error!("❌ i18n base_path lock poisoned in init"),
        }
        log::info!("🌐 Backend i18n initialized with path: {i18n_path:?}");

        // Pre-load default language
        self.load_language(DEFAULT_LANG);
    }

    /// Load a language directory into the cache
    fn load_language(&self, lang: &str) -> bool {
        let base_path = if let Ok(p) = self.base_path.read() {
            p.clone()
        } else {
            log::error!("❌ i18n base_path lock poisoned in load_language");
            None
        };

        if let Some(path) = base_path {
            let main_file = path.join(lang).join("main.json");
            let mut backend_translations = serde_json::Map::new();

            if main_file.exists() {
                match std::fs::read_to_string(&main_file) {
                    Ok(content) => match serde_json::from_str::<Value>(&content) {
                        Ok(Value::Object(map)) => {
                            for key in [
                                "tray",
                                "notification",
                                "powerInhibitor",
                                "alerts",
                                "backendErrors",
                            ] {
                                if let Some(val) = map.get(key) {
                                    backend_translations.insert(key.to_string(), val.clone());
                                }
                            }
                        }
                        Ok(_) => log::warn!("Skipping non-object JSON file: {main_file:?}"),
                        Err(e) => log::warn!("Failed to parse {main_file:?}: {e}"),
                    },
                    Err(e) => log::warn!("Failed to read {main_file:?}: {e}"),
                }
            } else {
                log::warn!("Translation file not found: {main_file:?}");
            }

            if !backend_translations.is_empty() {
                match self.cache.write() {
                    Ok(mut cache) => {
                        cache.insert(lang.to_string(), Value::Object(backend_translations));
                        log::info!("🌐 Loaded backend translations for: {lang}");
                        return true;
                    }
                    Err(_) => {
                        log::error!("❌ i18n cache lock poisoned in load_language for {lang}");
                    }
                }
            }
        } else {
            log::warn!("i18n base path not initialized yet");
        }
        false
    }

    fn get_dict(&self, lang: &str) -> Option<Value> {
        // Try to get from cache
        match self.cache.read() {
            Ok(cache) => {
                if let Some(dict) = cache.get(lang) {
                    return Some(dict.clone());
                }
            }
            Err(_) => log::error!("❌ i18n cache lock poisoned in get_dict (initial read)"),
        }

        // Not in cache, try to load
        if self.load_language(lang) {
            match self.cache.read() {
                Ok(cache) => {
                    return cache.get(lang).cloned();
                }
                Err(_) => log::error!("❌ i18n cache lock poisoned in get_dict (read after load)"),
            }
        }

        // Fallback to default language
        if lang != DEFAULT_LANG {
            match self.cache.read() {
                Ok(cache) => {
                    return cache.get(DEFAULT_LANG).cloned();
                }
                Err(_) => {
                    log::error!("❌ i18n cache lock poisoned in get_dict (fallback read)");
                }
            }
        }

        None
    }

    fn resolve(&self, key: &str) -> String {
        let lang = if let Ok(l) = self.current_lang.read() {
            l.clone()
        } else {
            log::error!("❌ i18n current_lang lock poisoned in resolve");
            DEFAULT_LANG.to_string()
        };

        let dict = match self.get_dict(&lang) {
            Some(d) => d,
            None => return key.to_string(),
        };

        let mut current = &dict;
        for part in key.split('.') {
            match current.get(part) {
                Some(v) => current = v,
                None => return key.to_string(),
            }
        }

        current.as_str().unwrap_or(key).to_string()
    }

    fn resolve_param_value(&self, value: &str) -> String {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return String::new();
        }

        // 1. If it's a structured JSON error string: {"key":"...", "params":{...}}
        if ((trimmed.starts_with('{') && trimmed.ends_with('}'))
            || trimmed.contains(r#"{"key":""#)
            || trimmed.contains(r#"{"key": ""#))
            && let Ok(val) = serde_json::from_str::<Value>(trimmed)
            && let Some(key) = val.get("key").and_then(|k| k.as_str())
        {
            if let Some(params_obj) = val.get("params").and_then(|p| p.as_object()) {
                let resolved_params: Vec<(String, String)> = params_obj
                    .iter()
                    .map(|(k, v)| {
                        let val_str = match v {
                            Value::String(s) => self.resolve_param_value(s),
                            _ => v.to_string(),
                        };
                        (k.clone(), val_str)
                    })
                    .collect();
                let params_ref: Vec<(&str, &str)> = resolved_params
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();
                let translated = self.resolve_with_params(key, &params_ref);
                if translated != key {
                    return translated;
                }
            } else {
                let translated = self.resolve(key);
                if translated != key {
                    return translated;
                }
            }
        }

        // 2. If it's a translation key (e.g. "backendErrors.mount.pointEmpty")
        if trimmed.starts_with("backendErrors.")
            || (trimmed.contains('.')
                && !trimmed.contains(' ')
                && !trimmed.contains('/')
                && !trimmed.contains('\\'))
        {
            let translated = self.resolve(trimmed);
            if translated != trimmed {
                return translated;
            }
        }

        // 3. Fallback: plain string as-is
        trimmed.to_string()
    }

    fn resolve_with_params(&self, key: &str, params: &[(&str, &str)]) -> String {
        let mut result = self.resolve(key);
        for (param_key, param_value) in params {
            let placeholder = format!("{{{{{param_key}}}}}");
            let resolved_val = self.resolve_param_value(param_value);
            result = result.replace(&placeholder, &resolved_val);
        }
        result
    }
}

/// Initialize the i18n system with the app's resource directory
/// Call this once during app startup
pub fn init(resource_dir: PathBuf) {
    TRANSLATIONS.init(resource_dir);
}

/// Set the current language for backend translations
pub fn set_language(lang: &str) {
    match TRANSLATIONS.current_lang.write() {
        Ok(mut current) => {
            *current = lang.to_string();
            log::info!("🌐 Backend language set to: {lang}");
        }
        Err(_) => log::error!("❌ i18n current_lang lock poisoned in set_language"),
    }
    // Pre-load the language if not cached
    TRANSLATIONS.load_language(lang);
}

/// Apply a language change across the application (backend, frontend event, and tray)
pub fn apply_language_change(app: &AppHandle, lang: &str) {
    log::debug!("🌐 Applying language change to: {lang}");
    set_language(lang);

    // Notify frontend
    if let Err(e) = app.emit(
        crate::utils::types::events::APP_EVENT,
        serde_json::json!({ "status": "language_changed", "language": lang }),
    ) {
        log::error!("Failed to emit language change event: {e}");
    }

    // Update tray menu
    #[cfg(feature = "tray")]
    {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::core::tray::core::update_tray_menu(app_handle).await {
                log::error!("Failed to update tray menu: {e}");
            }
        });
    }
}

/// Translate a key to the current language
pub fn t(key: &str) -> String {
    TRANSLATIONS.resolve(key)
}

/// Translate a key with parameter interpolation (automatically resolves structured error params)
pub fn t_with_params(key: &str, params: &[(&str, &str)]) -> String {
    TRANSLATIONS.resolve_with_params(key, params)
}

#[cfg(test)]
pub fn init_test_translations() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let resource_dir = manifest_dir.parent().unwrap().join("resources");
    init(resource_dir);
}

#[cfg(test)]
pub fn set_test_translations(lang: &str, dict: Value) {
    let mut cache = TRANSLATIONS.cache.write().unwrap();
    cache.insert(lang.to_string(), dict);
}

/// Translates a backend error message (structured JSON, translation key, or raw string)
pub fn resolve_error(error_str: &str) -> String {
    TRANSLATIONS.resolve_param_value(error_str)
}

/// Macro for ergonomic translations
///
/// # Usage
///
/// Simple translation:
/// ```
/// use rclone_manager_lib::t;
/// let label = t!("tray.showApp");
/// ```
///
/// With parameters:
/// ```
/// use rclone_manager_lib::t;
/// let label = t!("tray.mountCount", "active" => "2", "total" => "5");
/// ```
#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::utils::i18n::t($key)
    };
    ($key:expr, $($param_key:expr => $param_value:expr),+ $(,)?) => {{
        let params = [$(($param_key, $param_value.to_string())),+];
        let params_ref = params
            .iter()
            .map(|(k, v)| (*k, v.as_str()))
            .collect::<Vec<(&str, &str)>>();
        $crate::utils::i18n::t_with_params($key, &params_ref)
    }};
}

// ============================================================================
// Frontend-facing macros (unchanged from original)
// ============================================================================

#[macro_export]
macro_rules! localized_error {
    ($key:expr) => {
        $key.to_string()
    };
    ($key:expr, $($param_key:expr => $param_value:expr),+ $(,)?) => {{
        serde_json::json!({
            "key": $key,
            "params": {
                $($param_key: $param_value.to_string()),+
            }
        }).to_string()
    }};
}

/// Create a localized success message string for frontend
#[macro_export]
macro_rules! localized_success {
    ($key:expr) => {
        $key.to_string()
    };
    ($key:expr, $($param_key:expr => $param_value:expr),+ $(,)?) => {{
        serde_json::json!({
            "key": $key,
            "params": {
                $($param_key: $param_value.to_string()),+
            }
        }).to_string()
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_static_error() {
        let error = localized_error!("backendErrors.mount.pointEmpty");
        assert_eq!(error, "backendErrors.mount.pointEmpty");
    }

    #[test]
    fn test_dynamic_error() {
        let mount_point = "/mnt/drive";
        let remote = "gdrive";
        let error = localized_error!(
            "backendErrors.mount.alreadyInUse",
            "mountPoint" => mount_point,
            "remote" => remote
        );

        let parsed: serde_json::Value = serde_json::from_str(&error).unwrap();
        assert_eq!(parsed["key"], "backendErrors.mount.alreadyInUse");
        assert_eq!(parsed["params"]["mountPoint"], "/mnt/drive");
        assert_eq!(parsed["params"]["remote"], "gdrive");
    }

    #[test]
    fn test_t_fallback() {
        // Without init, should fall back to key
        let result = t!("nonexistent.key");
        assert_eq!(result, "nonexistent.key");
    }

    #[test]
    fn test_nested_resolution() {
        super::init_test_translations();
        assert_eq!(super::t("tray.showApp"), "Show App");
        assert_eq!(super::t("tray.nonexistent"), "tray.nonexistent");
    }

    #[test]
    fn test_resolve_error_structured_json() {
        super::init_test_translations();

        let json_err = localized_error!(
            "backendErrors.job.executionFailed",
            "error" => "failed to mount FUSE fs: no such directory"
        );
        let resolved = resolve_error(&json_err);
        assert_eq!(
            resolved,
            "Job execution failed: failed to mount FUSE fs: no such directory"
        );

        let key_err = localized_error!("backendErrors.mount.pointEmpty");
        let resolved_key = resolve_error(&key_err);
        assert_eq!(resolved_key, "Mount point cannot be empty");

        let multi_param_err = localized_error!(
            "backendErrors.mount.alreadyInUse",
            "mountPoint" => "/mnt/pcloud",
            "remote" => "pcloud:"
        );
        let resolved_multi = resolve_error(&multi_param_err);
        assert_eq!(
            resolved_multi,
            "Mount point /mnt/pcloud is already in use by remote pcloud:"
        );

        // Fallback to raw string
        let raw_err = "failed to exec mount: no such file or directory";
        assert_eq!(resolve_error(raw_err), raw_err);

        // Empty string
        assert_eq!(resolve_error(""), "");
    }
}
