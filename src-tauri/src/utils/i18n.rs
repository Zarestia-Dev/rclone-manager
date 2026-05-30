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
            let lang_dir = path.join(lang);
            let mut merged_translations = serde_json::Map::new();

            if lang_dir.exists() && lang_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&lang_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|s| s.to_str()) == Some("json") {
                            match std::fs::read_to_string(&path) {
                                Ok(content) => match serde_json::from_str::<Value>(&content) {
                                    Ok(Value::Object(map)) => {
                                        merged_translations.extend(map);
                                    }
                                    Ok(_) => {
                                        log::warn!("Skipping non-object JSON file: {path:?}");
                                    }
                                    Err(e) => {
                                        log::warn!("Failed to parse {path:?}: {e}");
                                    }
                                },
                                Err(e) => {
                                    log::warn!("Failed to read {path:?}: {e}");
                                }
                            }
                        }
                    }
                }
            } else {
                log::warn!("Language directory not found: {lang_dir:?}");
            }

            if !merged_translations.is_empty() {
                match self.cache.write() {
                    Ok(mut cache) => {
                        cache.insert(lang.to_string(), Value::Object(merged_translations));
                        log::info!("🌐 Loaded translations for: {lang}");
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

        let cache = if let Ok(c) = self.cache.read() {
            c
        } else {
            log::error!("❌ i18n cache lock poisoned in resolve");
            return key.to_string();
        };

        let dict = match cache.get(&lang).or_else(|| cache.get(DEFAULT_LANG)) {
            Some(d) => d,
            None => return key.to_string(),
        };

        let mut current = dict;
        for part in key.split('.') {
            match current.get(part) {
                Some(v) => current = v,
                None => return key.to_string(),
            }
        }

        current.as_str().unwrap_or(key).to_string()
    }

    fn resolve_with_params(&self, key: &str, params: &[(&str, &str)]) -> String {
        let mut result = self.resolve(key);
        for (param_key, param_value) in params {
            let placeholder = format!("{{{{{param_key}}}}}");
            result = result.replace(&placeholder, param_value);
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

/// Translate a key with parameter interpolation
pub fn t_with_params(key: &str, params: &[(&str, &str)]) -> String {
    TRANSLATIONS.resolve_with_params(key, params)
}

/// Get the full translation map for a language (merged from all JSON files)
pub fn get_language_map(lang: &str) -> Option<Value> {
    TRANSLATIONS.get_dict(lang)
}

/// Return the merged translations for a language (desktop invoke)
#[tauri::command]
pub fn get_i18n(lang: String) -> Result<Value, String> {
    get_language_map(&lang).ok_or_else(|| format!("Translations not found for: {lang}"))
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
        $crate::t!($key)
    };
    ($key:expr, $($param_key:expr => $param_value:expr),+ $(,)?) => {{
        $crate::t!($key, $($param_key => $param_value),+)
    }};
}

/// Create a localized success message string for frontend
#[macro_export]
macro_rules! localized_success {
    ($key:expr) => {
        $crate::t!($key)
    };
    ($key:expr, $($param_key:expr => $param_value:expr),+ $(,)?) => {{
        $crate::t!($key, $($param_key => $param_value),+)
    }};
}

#[cfg(test)]
mod tests {
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

        // Since translation files are not loaded in tests, it falls back to the key
        // Params are ignored in fallback if the key doesn't contain placeholders (which it doesn't here)
        assert_eq!(error, "backendErrors.mount.alreadyInUse");
    }

    #[test]
    fn test_t_fallback() {
        // Without init, should fall back to key
        let result = t!("nonexistent.key");
        assert_eq!(result, "nonexistent.key");
    }

    #[test]
    fn test_nested_resolution() {
        use serde_json::json;
        let mut cache = super::TRANSLATIONS.cache.write().unwrap();
        cache.insert(
            super::DEFAULT_LANG.to_string(),
            json!({
                "tray": {
                    "showApp": "Show Application",
                    "nested": {
                        "key": "Value"
                    }
                }
            }),
        );
        drop(cache);

        assert_eq!(super::t("tray.showApp"), "Show Application");
        assert_eq!(super::t("tray.nested.key"), "Value");
        assert_eq!(super::t("tray.nonexistent"), "tray.nonexistent");

        // Cleanup
        super::TRANSLATIONS.cache.write().unwrap().clear();
    }
}
