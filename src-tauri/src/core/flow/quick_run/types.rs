//! Types and data structures for the Flow workspace Quick Run feature.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::utils::types::remotes::OperationType;

/// A saved "quick run" record stored in `quick_runs` sub-settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickRun {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub operation_type: OperationType,
    pub remote_name: String,
    pub config: Value,
}

impl QuickRun {
    #[must_use]
    pub fn is_autostart(&self) -> bool {
        self.config
            .get("app")
            .and_then(|a| a.get("autoStart"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    #[must_use]
    pub fn is_cron_enabled(&self) -> bool {
        self.config
            .get("app")
            .and_then(|a| a.get("cronEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    #[must_use]
    pub fn cron_expression(&self) -> Option<String> {
        self.config
            .get("app")
            .and_then(|a| a.get("cronExpression"))
            .and_then(Value::as_str)
            .map(String::from)
    }

    #[must_use]
    pub fn is_watch_enabled(&self) -> bool {
        self.config
            .get("app")
            .and_then(|a| a.get("watchEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    #[allow(dead_code)]
    #[must_use]
    pub fn is_show_on_tray(&self) -> bool {
        self.config
            .get("app")
            .and_then(|a| a.get("showOnTray"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    #[must_use]
    pub fn watch_paths(&self) -> Vec<String> {
        let app = self.config.get("app");
        let rclone = self.config.get("rclone");

        let mut paths = Vec::new();

        if let Some(arr) = app
            .and_then(|a| a.get("watchPaths"))
            .and_then(Value::as_array)
        {
            for v in arr {
                if let Some(s) = v.as_str()
                    && !s.trim().is_empty()
                {
                    paths.push(s.to_string());
                }
            }
        }

        if paths.is_empty() {
            if let Some(src) = rclone.and_then(|r| r.get("srcFs")).and_then(Value::as_str)
                && !src.trim().is_empty()
            {
                paths.push(src.to_string());
            }
            if let Some(sources) = rclone
                .and_then(|r| r.get("source"))
                .and_then(Value::as_array)
            {
                for v in sources {
                    if let Some(s) = v.as_str()
                        && !s.trim().is_empty()
                    {
                        paths.push(s.to_string());
                    }
                }
            }
        }

        paths
    }
}

/// Input payload sent from frontend when creating or updating a quick run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickRunInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub operation_type: OperationType,
    pub remote_name: String,
    pub config: Value,
}

pub use crate::utils::types::remotes::OperationExecutionResult;

/// Response returned by `start_quick_run`.
pub type StartQuickRunResponse = OperationExecutionResult;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_quick_run_serde_roundtrip() {
        let qr = QuickRun {
            id: "qr-123".to_string(),
            name: "Test Quick Run".to_string(),
            description: Some("Description".to_string()),
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config: json!({
                "app": {},
                "rclone": { "srcFs": "drive:source", "dstFs": "drive:dest" }
            }),
        };

        let json_str = serde_json::to_string(&qr).unwrap();
        assert!(json_str.contains("\"operationType\":\"sync\""));
        assert!(json_str.contains("\"remoteName\":\"drive:\""));

        let deserialized: QuickRun = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized, qr);
    }

    #[test]
    fn test_quick_run_input_serde() {
        let input_json = json!({
            "name": "New Quick Run",
            "operationType": "copy",
            "remoteName": "gdrive:",
            "config": { "app": {}, "rclone": {} }
        });

        let input: QuickRunInput = serde_json::from_value(input_json).unwrap();
        assert_eq!(input.name, "New Quick Run");
        assert_eq!(input.operation_type, OperationType::Copy);
        assert_eq!(input.remote_name, "gdrive:");
        assert!(input.id.is_none());
    }

    #[test]
    fn test_quick_run_autostart_and_cron_helpers() {
        let qr_disabled = QuickRun {
            id: "qr-1".to_string(),
            name: "Disabled".to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config: json!({
                "app": {
                    "autoStart": false,
                    "cronEnabled": false,
                    "watchEnabled": false
                }
            }),
        };

        assert!(!qr_disabled.is_autostart());
        assert!(!qr_disabled.is_cron_enabled());
        assert!(qr_disabled.cron_expression().is_none());
        assert!(!qr_disabled.is_watch_enabled());
        assert!(qr_disabled.is_show_on_tray()); // Default when omitted is true

        let qr_enabled = QuickRun {
            id: "qr-2".to_string(),
            name: "Enabled".to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config: json!({
                "app": {
                    "autoStart": true,
                    "cronEnabled": true,
                    "cronExpression": "0 2 * * *",
                    "watchEnabled": true,
                    "watchPaths": ["/local/path"],
                    "showOnTray": false
                }
            }),
        };

        assert!(qr_enabled.is_autostart());
        assert!(qr_enabled.is_cron_enabled());
        assert_eq!(qr_enabled.cron_expression(), Some("0 2 * * *".to_string()));
        assert!(qr_enabled.is_watch_enabled());
        assert!(!qr_enabled.is_show_on_tray()); // Explicit false
        assert_eq!(qr_enabled.watch_paths(), vec!["/local/path".to_string()]);
    }

    #[test]
    fn test_quick_run_watch_paths_fallback() {
        let qr_fallback = QuickRun {
            id: "qr-3".to_string(),
            name: "Fallback".to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config: json!({
                "app": {},
                "rclone": {
                    "srcFs": "/fallback/source/path"
                }
            }),
        };

        assert_eq!(
            qr_fallback.watch_paths(),
            vec!["/fallback/source/path".to_string()]
        );
    }
}
