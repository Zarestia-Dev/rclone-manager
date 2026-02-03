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

/// Directory where backend translation files are stored (relative to executable)
const I18N_DIR: &str = "i18n";
const DEFAULT_LANG: &str = "en-US";

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
        if let Ok(mut path) = self.base_path.write() {
            *path = Some(i18n_path.clone());
        }
        log::info!("🌐 Backend i18n initialized with path: {:?}", i18n_path);

        // Pre-load default language
        self.load_language(DEFAULT_LANG);
    }

    /// Load a language directory into the cache
    fn load_language(&self, lang: &str) -> bool {
        let base_path = self.base_path.read().ok().and_then(|p| p.clone());

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
                                        log::warn!("Skipping non-object JSON file: {:?}", path);
                                    }
                                    Err(e) => {
                                        log::warn!("Failed to parse {:?}: {}", path, e);
                                    }
                                },
                                Err(e) => {
                                    log::warn!("Failed to read {:?}: {}", path, e);
                                }
                            }
                        }
                    }
                }
            } else {
                log::warn!("Language directory not found: {:?}", lang_dir);
            }

            if !merged_translations.is_empty()
                && let Ok(mut cache) = self.cache.write()
            {
                cache.insert(lang.to_string(), Value::Object(merged_translations));
                log::info!("🌐 Loaded translations for: {}", lang);
                return true;
            }
        } else {
            log::warn!("i18n base path not initialized yet");
        }
        false
    }

    fn get_dict(&self, lang: &str) -> Option<Value> {
        // Try to get from cache
        if let Ok(cache) = self.cache.read()
            && let Some(dict) = cache.get(lang)
        {
            return Some(dict.clone());
        }

        // Not in cache, try to load
        if self.load_language(lang)
            && let Ok(cache) = self.cache.read()
        {
            return cache.get(lang).cloned();
        }

        // Fallback to default language
        if lang != DEFAULT_LANG
            && let Ok(cache) = self.cache.read()
        {
            return cache.get(DEFAULT_LANG).cloned();
        }

        None
    }

    fn resolve(&self, key: &str) -> String {
        let lang = self
            .current_lang
            .read()
            .map(|l| l.clone())
            .unwrap_or_else(|_| DEFAULT_LANG.to_string());

        let dict = match self.get_dict(&lang) {
            Some(d) => d,
            None => return key.to_string(),
        };

        // Navigate nested keys like "tray.showApp"
        let mut current = &dict;
        for part in key.split('.') {
            match current.get(part) {
                Some(v) => current = v,
                None => return key.to_string(), // Fallback to key
            }
        }

        match current.as_str() {
            Some(s) => s.to_string(),
            None => key.to_string(),
        }
    }

    fn resolve_with_params(&self, key: &str, params: &[(&str, &str)]) -> String {
        let mut result = self.resolve(key);
        for (param_key, param_value) in params {
            let placeholder = format!("{{{{{}}}}}", param_key);
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
    if let Ok(mut current) = TRANSLATIONS.current_lang.write() {
        *current = lang.to_string();
        log::info!("🌐 Backend language set to: {}", lang);
    }
    // Pre-load the language if not cached
    TRANSLATIONS.load_language(lang);
}

/// Translate a key to the current language
pub fn t(key: &str) -> String {
    TRANSLATIONS.resolve(key)
}

/// Translate a key with parameter interpolation
pub fn t_with_params(key: &str, params: &[(&str, &str)]) -> String {
    TRANSLATIONS.resolve_with_params(key, params)
}

/// Macro for ergonomic translations
///
/// # Usage
///
/// Simple translation:
/// ```
/// let label = t!("tray.showApp");
/// ```
///
/// With parameters:
/// ```
/// let label = t!("tray.mountCount", "active" => "2", "total" => "5");
/// ```
#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::utils::i18n::t($key)
    };
    ($key:expr, $($param_key:expr => $param_value:expr),+ $(,)?) => {{
        let params = [$(($param_key, $param_value.to_string())),+];
        let params_ref: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
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
}
