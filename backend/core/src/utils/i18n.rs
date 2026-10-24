//! Internationalization helpers for backend
//!
//! This module provides:
//! 1. Macros to create localized error/success messages for frontend translation
//! 2. Runtime translation resolver for tray menu and notifications (loaded on demand)

use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;
use std::sync::{Arc, LazyLock};

include!(concat!(env!("OUT_DIR"), "/translations.rs"));
pub const DEFAULT_LANG: &str = "en-US";

fn translation_source(lang: &str) -> Option<std::borrow::Cow<'static, str>> {
    // Language identifiers are directory names, never paths.
    if lang.is_empty() || !lang.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return None;
    }
    #[cfg(all(debug_assertions, not(any(target_os = "android", target_os = "ios"))))]
    if let Ok(content) = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/i18n")
            .join(lang)
            .join("main.json"),
    ) {
        return Some(std::borrow::Cow::Owned(content));
    }
    embedded_translation_source(lang)
}

fn embedded_translation_source(lang: &str) -> Option<std::borrow::Cow<'static, str>> {
    TRANSLATION_SOURCES
        .iter()
        .find(|(name, _)| *name == lang)
        .map(|(_, source)| std::borrow::Cow::Borrowed(*source))
}

/// Global translations state
static TRANSLATIONS: LazyLock<Translations> = LazyLock::new(Translations::new);

struct Translations {
    current_lang: RwLock<String>,
    cache: RwLock<HashMap<String, Option<Arc<Value>>>>,
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
        let Ok(mut cache) = self.cache.write() else {
            log::error!("i18n cache lock poisoned for {lang}");
            return false;
        };
        if let Some(dict) = cache.get(lang) {
            return dict.is_some();
        }
        let dict = translation_source(lang).and_then(|content| {
            let map = match serde_json::from_str::<Value>(&content) {
                Ok(Value::Object(map)) => map,
                result => {
                    log::warn!("Invalid translation source for {lang}: {result:?}");
                    return None;
                }
            };
            let backend: serde_json::Map<String, Value> = map
                .into_iter()
                .filter(|(key, _)| {
                    matches!(
                        key.as_str(),
                        "tray" | "notification" | "powerInhibitor" | "alerts" | "backendErrors"
                    )
                })
                .collect();
            (!backend.is_empty()).then(|| Arc::new(Value::Object(backend)))
        });
        if dict.is_none() {
            log::warn!("Backend translations unavailable: {lang}");
        }
        let loaded = dict.is_some();
        // Remember unavailable languages too, so notifications don't repeat failed I/O.
        cache.insert(lang.to_owned(), dict);
        loaded
    }

    fn get_dict(&self, lang: &str) -> Option<Arc<Value>> {
        // The common path needs only a shared lock and an Arc clone.
        if let Ok(cache) = self.cache.read()
            && let Some(dict) = cache.get(lang)
            && let Some(dict) = dict
        {
            return Some(dict.clone());
        }
        self.load_language(lang);
        let dict = self.cache.read().ok()?.get(lang).cloned().flatten();
        dict.or_else(|| {
            if lang != DEFAULT_LANG {
                self.get_dict(DEFAULT_LANG)
            } else {
                None
            }
        })
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

        let mut current = dict.as_ref();
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
            if *current != lang {
                *current = lang.to_string();
                log::info!("🌐 Backend language set to: {lang}");
            }
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
    fn embedded_sources_resolve_notification_text_without_host_files() {
        let source = embedded_translation_source(DEFAULT_LANG).unwrap();
        assert!(matches!(source, std::borrow::Cow::Borrowed(_)));
        let dict: Value = serde_json::from_str(&source).unwrap();
        assert_eq!(
            dict["notification"]["title"]["jobStarted"],
            "{{type}} Process Started"
        );
        assert!(embedded_translation_source("missing-language").is_none());
        for invalid in ["", "../en-US", "/en-US", "en-US/main.json", "en_US"] {
            assert!(translation_source(invalid).is_none());
        }
    }

    #[test]
    fn cached_languages_are_reused_and_fallback_is_loaded_lazily() {
        let translations = Translations::new();
        let first = translations.get_dict(DEFAULT_LANG).unwrap();
        translations.init();
        assert!(Arc::ptr_eq(
            &first,
            &translations.get_dict(DEFAULT_LANG).unwrap()
        ));
        assert!(first.get("notification").is_some());
        assert!(first.get("settings").is_none());

        let fresh = Translations::new();
        let fallback = fresh.get_dict("missing-language").unwrap();
        assert!(Arc::ptr_eq(
            &fallback,
            &fresh.get_dict("missing-language").unwrap()
        ));
        assert!(
            fresh
                .cache
                .read()
                .unwrap()
                .get("missing-language")
                .unwrap()
                .is_none()
        );
        assert!(Arc::ptr_eq(
            &fallback,
            &fresh.get_dict(DEFAULT_LANG).unwrap()
        ));
    }

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
        super::init();
        assert_eq!(super::t("tray.showApp"), "Show App");
        assert_eq!(super::t("tray.nonexistent"), "tray.nonexistent");
    }

    #[test]
    fn notification_parameters_resolve_structured_errors_keys_and_raw_text() {
        super::init();

        let json_err = localized_error!(
            "backendErrors.job.executionFailed",
            "error" => "failed to mount FUSE fs: no such directory"
        );
        let key_err = localized_error!("backendErrors.mount.pointEmpty");
        let multi_param_err = localized_error!(
            "backendErrors.mount.alreadyInUse",
            "mountPoint" => "/mnt/pcloud",
            "remote" => "pcloud:"
        );
        for (input, expected) in [
            (
                json_err.as_str(),
                "Job execution failed: failed to mount FUSE fs: no such directory",
            ),
            (key_err.as_str(), "Mount point cannot be empty"),
            (
                multi_param_err.as_str(),
                "Mount point /mnt/pcloud is already in use by remote pcloud:",
            ),
            ("  Arşiv & 旅行  ", "Arşiv & 旅行"),
            ("backendErrors.unknown", "backendErrors.unknown"),
            ("{invalid JSON}", "{invalid JSON}"),
            ("", ""),
        ] {
            assert_eq!(
                t_with_params("notification.body.engineAuthFailed", &[("error", input)]),
                format!("Failed to authenticate with rclone engine: {expected}")
            );
        }
    }

    #[test]
    fn test_resolve_unmount_failed() {
        super::init();
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
