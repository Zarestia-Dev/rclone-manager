use serde_json::Value;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::utils::types::logs::LogLevel;
use crate::utils::types::origin::Origin;

/// Small, typed notification model to replace the old stringly API.
/// Keep this minimal and explicit so callers cannot accidentally pass JSON strings.
#[derive(Debug, Clone)]
pub enum Text {
    Localized {
        key: String,
        params: Option<std::collections::HashMap<String, String>>,
    },
    Raw(String),
}

#[derive(Debug, Clone)]
pub struct Notification {
    pub title: Text,
    pub body: Text,
    pub level: Option<LogLevel>,
    pub meta: Option<Value>,
}

impl Notification {
    /// Helper to create a localized notification from small param tuples.
    /// Keep calling sites readable without reintroducing string heuristics.
    pub fn localized(
        title_key: &str,
        body_key: &str,
        params: Option<Vec<(&str, &str)>>,
        meta: Option<Value>,
        level: Option<LogLevel>,
    ) -> Self {
        let map = params.map(|v| {
            v.into_iter()
                .map(|(k, val)| (k.to_string(), val.to_string()))
                .collect()
        });
        Notification {
            title: Text::Localized {
                key: title_key.to_string(),
                params: map.clone(),
            },
            body: Text::Localized {
                key: body_key.to_string(),
                params: map,
            },
            level,
            meta,
        }
    }

    pub fn raw(title: &str, body: &str) -> Self {
        Notification {
            title: Text::Raw(title.to_string()),
            body: Text::Raw(body.to_string()),
            level: None,
            meta: None,
        }
    }
}

/// Translate a `Text` value into a display string.
fn translate_text_value(text: &Text) -> String {
    match text {
        Text::Raw(s) => s.clone(),
        Text::Localized { key, params } => {
            if let Some(map) = params {
                // Convert HashMap<String,String> -> Vec<(&str,&str)>
                let param_refs: Vec<(&str, &str)> =
                    map.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                let translated = crate::utils::i18n::t_with_params(key, &param_refs);
                if translated != *key {
                    log::debug!("🔔 Translated '{}' with params to '{}'", key, translated);
                    return translated;
                }
            } else {
                let translated = crate::utils::i18n::t(key);
                if translated != *key {
                    log::debug!("🔔 Translated key '{}' => '{}'", key, translated);
                    return translated;
                }
            }
            // Fallback to key if translation not found
            key.clone()
        }
    }
}

/// Origins that should be suppressed when the app is focused.
/// Centralized so the list is easy to update / test.
fn origin_is_suppressible(origin: Option<&Origin>) -> bool {
    matches!(
        origin,
        Some(Origin::Ui)
            | Some(Origin::Internal)
            | Some(Origin::Dashboard)
            | Some(Origin::Nautilus)
    )
}

/// Pure helper: returns true when a notification should be suppressed given
/// whether the app is focused and the notification origin. Extracted to make
/// suppression logic testable without requiring an `AppHandle`.
pub(crate) fn should_suppress(is_focused: bool, origin: Option<&Origin>) -> bool {
    is_focused && origin_is_suppressible(origin)
}

/// Send a typed notification with automatic translation and suppression rules.
///
/// Replaces the old string-based API; callers must pass `Notification`.
pub fn send_notification_typed(
    app: &tauri::AppHandle,
    notification: Notification,
    origin: Option<Origin>,
) {
    let enabled: bool = app
        .try_state::<crate::core::settings::AppSettingsManager>()
        .and_then(|manager| manager.inner().get("general.notifications").ok())
        .unwrap_or(false);

    // Suppress if app is focused and the origin is a UI-like origin
    let is_focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));

    let should_suppress = should_suppress(is_focused, origin.as_ref());

    let translated_title = translate_text_value(&notification.title);
    let mut translated_body = translate_text_value(&notification.body);

    // Fallback: if body contains an error field (legacy error-payloads)
    if translated_body.starts_with('{')
        && let Ok(parsed) = serde_json::from_str::<Value>(&translated_body)
        && let Some(err) = parsed
            .get("params")
            .and_then(|p| p.get("error"))
            .and_then(|e| e.as_str())
    {
        translated_body = format!("Error: {}", err);
        log::warn!(
            "🔔 Notification translation fallback used: {}",
            translated_body
        );
    }

    // If the Notification carries an explicit level, also emit a log at that level
    if let Some(level) = &notification.level {
        match level {
            LogLevel::Error => log::error!("🔔 {} - {}", translated_title, translated_body),
            LogLevel::Warn => log::warn!("🔔 {} - {}", translated_title, translated_body),
            LogLevel::Info => log::info!("🔔 {} - {}", translated_title, translated_body),
            LogLevel::Debug => log::debug!("🔔 {} - {}", translated_title, translated_body),
            LogLevel::Trace => log::trace!("🔔 {} - {}", translated_title, translated_body),
        }
    }

    log::debug!(
        "🔔 Notification: {} - {} (origin={:?}, focused={}, suppressed={})",
        translated_title,
        translated_body,
        origin,
        is_focused,
        should_suppress
    );

    if enabled && !should_suppress {
        if let Err(e) = app
            .notification()
            .builder()
            .title(&translated_title)
            .body(&translated_body)
            .auto_cancel()
            .show()
        {
            log::error!("Failed to show notification: {e}");
        }
    } else if enabled && should_suppress {
        log::debug!("🔕 Notification suppressed (app is focused and origin is UI)");
    } else {
        log::debug!("🔕 Notifications disabled");
    }
}

// Backward shims removed — all call sites migrated to the typed `Notification` API.
// The old stringly-parsing heuristics were fragile and have been intentionally deleted.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::logs::LogLevel;

    #[test]
    fn text_raw_returns_raw() {
        let t = Text::Raw("plain text".to_string());
        assert_eq!(translate_text_value(&t), "plain text".to_string());
    }

    #[test]
    fn localized_fallback_returns_key_when_missing() {
        // Expect the i18n helper to return the key unchanged when translation missing
        let key = "nonexistent.i18n.key";
        let t = Text::Localized {
            key: key.to_string(),
            params: None,
        };
        assert_eq!(translate_text_value(&t), key.to_string());
    }

    #[test]
    fn notification_localized_builder_includes_params() {
        let n = Notification::localized(
            "notification.title.test",
            "notification.body.test",
            Some(vec![("op", "Sync"), ("remote", "gdrive")]),
            None,
            Some(LogLevel::Info),
        );

        match n.title {
            Text::Localized { key, params } => {
                assert_eq!(key, "notification.title.test");
                let map = params.expect("params present");
                assert_eq!(map.get("op").map(|s| s.as_str()), Some("Sync"));
            }
            _ => panic!("expected localized title"),
        }

        match n.body {
            Text::Localized { key, params } => {
                assert_eq!(key, "notification.body.test");
                let map = params.expect("params present");
                assert_eq!(map.get("remote").map(|s| s.as_str()), Some("gdrive"));
            }
            _ => panic!("expected localized body"),
        }

        assert_eq!(n.level, Some(LogLevel::Info));
    }

    #[test]
    fn suppression_includes_dashboard_and_nautilus() {
        use crate::utils::types::origin::Origin;
        // Dashboard / Nautilus should be treated like other UI-origin sources
        assert!(origin_is_suppressible(Some(&Origin::Dashboard)));
        assert!(origin_is_suppressible(Some(&Origin::Nautilus)));
        // existing suppressed origins should still be suppressible
        assert!(origin_is_suppressible(Some(&Origin::Ui)));
        // non-UI/background origins should NOT be suppressible by default
        assert!(!origin_is_suppressible(Some(&Origin::Scheduled)));
        assert!(!origin_is_suppressible(Some(&Origin::System)));
    }

    #[test]
    fn test_should_suppress_respects_focus_and_origin() {
        use crate::utils::types::origin::Origin;
        // Suppress only when app is focused AND origin is UI-like
        assert!(should_suppress(true, Some(&Origin::Dashboard)));
        assert!(should_suppress(true, Some(&Origin::Nautilus)));
        assert!(should_suppress(true, Some(&Origin::Ui)));
        assert!(!should_suppress(true, Some(&Origin::Scheduled)));
        assert!(!should_suppress(false, Some(&Origin::Dashboard)));
    }
}
