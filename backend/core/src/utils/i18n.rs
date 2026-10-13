//! Internationalization helpers for backend
//!
//! This module provides:
//! 1. Macros to create localized error/success messages for frontend translation
//! 2. Runtime translation resolver for tray menu and notifications (loaded on demand)

use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::RwLock;

#[cfg(not(debug_assertions))]
include!(concat!(env!("OUT_DIR"), "/translations.rs"));
pub const DEFAULT_LANG: &str = "en-US";

fn translation_source(lang: &str) -> Option<std::borrow::Cow<'static, str>> {
    // Language identifiers are directory names, never paths.
    if lang.is_empty() || !lang.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return None;
    }
    #[cfg(debug_assertions)]
    {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../resources/i18n")
                .join(lang)
                .join("main.json"),
        )
        .ok()
        .map(std::borrow::Cow::Owned)
    }
    #[cfg(not(debug_assertions))]
    {
        TRANSLATION_SOURCES
            .iter()
            .find(|(name, _)| *name == lang)
            .map(|(_, source)| std::borrow::Cow::Borrowed(*source))
    }
}

/// Global translations state
static TRANSLATIONS: LazyLock<Translations> = LazyLock::new(Translations::new);

struct Translations {
    current_lang: RwLock<String>,
    cache: RwLock<HashMap<String, Value>>,
}

impl Translations {
    fn new() -> Self {
        Self {
            current_lang: RwLock::new(DEFAULT_LANG.to_string()),
            cache: RwLock::new(HashMap::new()),
        }
    }

    fn init(&self) {
        self.load_language(DEFAULT_LANG);
    }

    /// Cache only the sections needed by backend OS integrations.
    fn load_language(&self, lang: &str) -> bool {
        let Some(content) = translation_source(lang) else {
            log::warn!("Translation source not found: {lang}");
            return false;
        };
        let map = match serde_json::from_str::<Value>(&content) {
            Ok(Value::Object(map)) => map,
            result => {
                log::warn!("Invalid translation source for {lang}: {result:?}");
                return false;
            }
        };
        let backend_translations: serde_json::Map<String, Value> = map
            .into_iter()
            .filter(|(key, _)| {
                matches!(
                    key.as_str(),
                    "tray" | "notification" | "powerInhibitor" | "alerts" | "backendErrors"
                )
            })
            .collect();
        if backend_translations.is_empty() {
            return false;
        }
        match self.cache.write() {
            Ok(mut cache) => {
                cache.insert(lang.to_string(), Value::Object(backend_translations));
                true
            }
            Err(_) => {
                log::error!("i18n cache lock poisoned for {lang}");
                false
            }
        }
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

/// Initialize the backend translations
/// Call this once during app startup
pub fn init() {
    TRANSLATIONS.init();
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
pub fn apply_language_change(lang: &str) {
    log::debug!("🌐 Applying language change to: {lang}");
    set_language(lang);

    // Notify frontend
    crate::services::bridge::emit(
        crate::utils::types::events::APP_EVENT,
        serde_json::json!({ "status": "language_changed", "language": lang }),
    );

    crate::services::bridge::emit(crate::utils::types::events::UPDATE_TRAY_MENU, ());
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
    init();
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
/// use rclone_manager_core::t;
/// let label = t!("tray.showApp");
/// ```
///
/// With parameters:
/// ```
/// use rclone_manager_core::t;
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
    fn translation_sources_filter_sections_and_fall_back() {
        let translations = Translations::new();
        translations.init();
        let dict = translations.get_dict(DEFAULT_LANG).unwrap();
        assert_eq!(dict["tray"]["showApp"], "Show App");
        assert!(dict.as_object().unwrap().keys().all(|key| matches!(
            key.as_str(),
            "tray" | "notification" | "powerInhibitor" | "alerts" | "backendErrors"
        )));
        assert_eq!(translations.get_dict("unknown-language").unwrap(), dict);
        assert!(translation_source("../en-US").is_none());
        assert!(translation_source("").is_none());
    }

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

    #[test]
    fn test_resolve_unmount_failed() {
        super::init_test_translations();
        let rendered = t_with_params(
            "notification.body.unmountFailed",
            &[
                ("backend", "Local"),
                ("remote", "Google Drive"),
                ("error", "Device or resource busy"),
            ],
        );
        assert_eq!(
            rendered,
            "Failed to unmount Google Drive from Local: Device or resource busy"
        );
    }
}
