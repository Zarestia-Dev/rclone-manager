use serde_json::Value;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

/// Translate a string if it's a translation key or JSON with key+params
fn translate_text(text: &str) -> String {
    // Check if it's JSON with key+params (from localized_error!/localized_success! macros)
    if text.starts_with('{') && text.contains("\"key\"") {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            if let Some(key) = parsed.get("key").and_then(|k| k.as_str()) {
                let owned_params: Vec<(String, String)> = parsed
                    .get("params")
                    .and_then(|p| p.as_object())
                    .map(|obj| {
                        obj.iter()
                            .map(|(k, v)| {
                                // Handle both string and non-string values
                                let str_value = match v {
                                    Value::String(s) => {
                                        // Check if the string value is itself JSON (for nested errors)
                                        if s.starts_with('{') {
                                            // Try to extract user-friendly error message
                                            if let Ok(nested) = serde_json::from_str::<Value>(s) {
                                                // For HTTP errors, use the error field from the body
                                                if let Some(body) =
                                                    nested.get("error").and_then(|e| e.as_str())
                                                {
                                                    return (k.clone(), body.to_string());
                                                }
                                            }
                                        }
                                        s.clone()
                                    }
                                    Value::Number(n) => n.to_string(),
                                    _ => v.to_string(),
                                };
                                (k.clone(), str_value)
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                let param_refs: Vec<(&str, &str)> = owned_params
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();

                let translated = crate::utils::i18n::t_with_params(key, &param_refs);
                log::debug!("🔔 Translated '{}' with params to '{}'", key, translated);
                return translated;
            }
        } else {
            log::warn!("Failed to parse notification JSON: {}", text);
        }
    }

    // Check if it's a plain translation key (e.g., "notification.title.mountSuccess")
    if text.contains('.') && !text.contains(' ') && !text.contains(':') {
        let translated = crate::utils::i18n::t(text);
        if translated != text {
            log::debug!("🔔 Translated key '{}' => '{}'", text, translated);
            return translated;
        }
    }

    text.to_string()
}

/// Send a notification with automatic translation
///
/// Title and body can be:
/// - Plain text (displayed as-is)
/// - Translation keys (e.g., "notification.title.mountSuccess")
/// - JSON from localized_success!/localized_error! macros
///
/// # Example
/// ```no_run
/// use rclone_manager_lib::{localized_success, utils::app::notification::send_notification};
///
/// // AppHandle requires full Tauri mock, so we just show usage syntax here
/// fn example(app: &tauri::AppHandle) {
///     let remote = "drive";
///     let profile = "default";
///     
///     send_notification(app,
///         &localized_success!("notification.title.mountSuccess"),
///         &localized_success!("notification.body.mounted", "remote" => &remote, "profile" => &profile)
///     );
/// }
/// ```
pub fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    let enabled: bool = app
        .try_state::<crate::core::settings::AppSettingsManager>()
        .and_then(|manager| manager.inner().get("general.notifications").ok())
        .unwrap_or(false);

    // Translate title and body
    let translated_title = translate_text(title);
    let mut translated_body = translate_text(body);

    // If body is still JSON (translation failed), extract error message for fallback
    if translated_body.starts_with('{')
        && translated_body.contains("\"error\"")
        && let Ok(parsed) = serde_json::from_str::<Value>(&translated_body)
        && let Some(error) = parsed
            .get("params")
            .and_then(|p| p.get("error"))
            .and_then(|e| e.as_str())
    {
        translated_body = format!("Error: {}", error);
        log::warn!(
            "🔔 Notification translation failed, using error fallback: {}",
            translated_body
        );
    }

    log::debug!(
        "🔔 Notification: {} - {}",
        translated_title,
        translated_body
    );
    if enabled {
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
    } else {
        log::debug!("🔕 Notifications disabled");
    }
}
