//! Types and data structures for the Flow workspace Quick Run feature.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::utils::types::remotes::{OperationType, dest_path, source_paths};

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
    /// The app-level settings (scheduling, watching, tray); all of them are optional.
    fn app(&self) -> Option<&Value> {
        self.config.get("app")
    }

    #[must_use]
    pub fn is_autostart(&self) -> bool {
        self.app_flag("autoStart")
    }

    /// Seconds to wait after startup before auto-starting.
    #[must_use]
    pub fn autostart_delay_secs(&self) -> u64 {
        self.app_number("autoStartDelay").unwrap_or(0)
    }

    #[must_use]
    pub fn is_cron_enabled(&self) -> bool {
        self.app_flag("cronEnabled")
    }

    #[must_use]
    pub fn cron_expression(&self) -> Option<String> {
        self.app()?
            .get("cronExpression")?
            .as_str()
            .map(String::from)
    }

    #[must_use]
    pub fn is_watch_enabled(&self) -> bool {
        self.app_flag("watchEnabled")
    }

    /// Seconds to wait after a change before the watcher runs; `None` means the default.
    #[must_use]
    pub fn watch_delay(&self) -> Option<u64> {
        self.app_number("watchDelay")
    }

    #[must_use]
    pub fn watch_changed_only(&self) -> bool {
        self.app_flag("watchChangedOnly")
    }

    #[cfg(any(feature = "tray", test))]
    #[must_use]
    pub fn is_show_on_tray(&self) -> bool {
        self.app()
            .and_then(|app| app.get("showOnTray"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    /// What the watcher observes: the paths set for watching, else the paths the run reads from.
    #[must_use]
    pub fn watch_paths(&self) -> Vec<String> {
        let chosen: Vec<String> = self
            .app()
            .and_then(|app| app.get("watchPaths"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .map(String::from)
            .collect();
        if !chosen.is_empty() {
            return chosen;
        }
        self.config
            .get("rclone")
            .map(source_paths)
            .unwrap_or_default()
            .into_iter()
            .filter(|path| !path.trim().is_empty())
            .collect()
    }

    /// Where the run writes to, for the automation that watches or schedules it.
    #[must_use]
    pub fn dest_path(&self) -> Option<String> {
        self.config
            .get("rclone")
            .and_then(dest_path)
            .filter(|path| !path.trim().is_empty())
    }

    fn app_flag(&self, key: &str) -> bool {
        self.app()
            .and_then(|app| app.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn app_number(&self, key: &str) -> Option<u64> {
        self.app()?.get(key)?.as_u64()
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
    fn test_quick_run_autostart_delay_is_optional() {
        let with_config = |config: Value| QuickRun {
            id: "qr".to_string(),
            name: "Delayed".to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config,
        };

        assert_eq!(with_config(json!({})).autostart_delay_secs(), 0);
        assert_eq!(
            with_config(json!({"app": {"autoStart": true}})).autostart_delay_secs(),
            0
        );
        assert_eq!(
            with_config(json!({"app": {"autoStartDelay": 15}})).autostart_delay_secs(),
            15
        );
        assert_eq!(
            with_config(json!({"app": {"autoStartDelay": "15"}})).autostart_delay_secs(),
            0
        );
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

    fn with_config(config: Value) -> QuickRun {
        QuickRun {
            id: "qr".to_string(),
            name: "Run".to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "drive:".to_string(),
            config,
        }
    }

    #[test]
    fn test_quick_run_watch_settings_are_optional() {
        let none = with_config(json!({}));
        assert_eq!(none.watch_delay(), None);
        assert!(!none.watch_changed_only());

        let set = with_config(json!({"app": {"watchDelay": 7, "watchChangedOnly": true}}));
        assert_eq!(set.watch_delay(), Some(7));
        assert!(set.watch_changed_only());

        let wrong_types =
            with_config(json!({"app": {"watchDelay": "7", "watchChangedOnly": "yes"}}));
        assert_eq!(wrong_types.watch_delay(), None);
        assert!(!wrong_types.watch_changed_only());
    }

    #[test]
    fn test_quick_run_watches_the_chosen_paths_first() {
        let qr = with_config(json!({
            "app": {"watchPaths": ["/chosen", "  ", ""]},
            "rclone": {"srcFs": "/ignored"}
        }));
        assert_eq!(qr.watch_paths(), vec!["/chosen".to_string()]);
    }

    #[test]
    fn test_quick_run_watches_the_paths_the_run_reads_from() {
        // The same key wins as when the operation runs: `source` before `srcFs`.
        let both = with_config(json!({"rclone": {"srcFs": "/a", "source": ["/b", "/c"]}}));
        assert_eq!(both.watch_paths(), vec!["/b".to_string(), "/c".to_string()]);

        let bisync = with_config(json!({"rclone": {"path1": "/left", "path2": "/right"}}));
        assert_eq!(bisync.watch_paths(), vec!["/left".to_string()]);

        let blank_watch =
            with_config(json!({"app": {"watchPaths": [" "]}, "rclone": {"fs": "x:"}}));
        assert_eq!(blank_watch.watch_paths(), vec!["x:".to_string()]);

        assert!(with_config(json!({})).watch_paths().is_empty());
        assert!(
            with_config(json!({"rclone": {"srcFs": ""}}))
                .watch_paths()
                .is_empty()
        );
        assert!(
            with_config(json!({"rclone": {"source": "  "}}))
                .watch_paths()
                .is_empty()
        );
    }

    #[test]
    fn test_quick_run_dest_path_skips_blank_values() {
        let dest = |rclone: Value| with_config(json!({ "rclone": rclone })).dest_path();

        assert_eq!(dest(json!({"dstFs": "/out"})).as_deref(), Some("/out"));
        assert_eq!(dest(json!({"mountPoint": "/mnt"})).as_deref(), Some("/mnt"));
        assert_eq!(dest(json!({"dest": "  "})), None);
        assert_eq!(with_config(json!({})).dest_path(), None);
    }
}
