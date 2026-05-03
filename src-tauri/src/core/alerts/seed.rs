use crate::core::alerts::cache;
use crate::core::alerts::types::{AlertAction, AlertRule, AlertSeverity, OsToastAction};
use crate::core::settings::AppSettingsManager;
use chrono::Utc;
use log::{error, info};

pub const DEFAULT_ACTION_ID: &str = "default-os-toast";
pub const DEFAULT_RULE_ID: &str = "default-rule";

pub fn seed_defaults(manager: &AppSettingsManager) -> Result<(), String> {
    let notifications_on = manager.get::<bool>("general.notifications").unwrap_or(true);

    if cache::get_action(manager, DEFAULT_ACTION_ID).is_none() {
        info!("Seeding default OS toast action (enabled={notifications_on})");
        let action = AlertAction::OsToast(OsToastAction {
            id: DEFAULT_ACTION_ID.to_string(),
            name: "alerts.defaultActionName".to_string(),
            enabled: notifications_on,
        });
        if let Err(e) = cache::upsert_action(manager, action) {
            error!("Failed to seed default action: {e}");
        }
    }

    if cache::get_rule(manager, DEFAULT_RULE_ID).is_none() {
        info!("Seeding default alert rule (enabled={notifications_on})");
        let rule = AlertRule {
            id: DEFAULT_RULE_ID.to_string(),
            name: "alerts.defaultRuleName".to_string(),
            enabled: notifications_on,
            event_filter: vec![],
            severity_min: AlertSeverity::Info,
            remote_filter: vec![],
            origin_filter: vec![],
            backend_filter: vec![],
            profile_filter: vec![],
            action_ids: vec![DEFAULT_ACTION_ID.to_string()],
            cooldown_secs: 0,
            created_at: Utc::now(),
            last_fired: None,
            fire_count: 0,
            auto_acknowledge: true,
        };
        if let Err(e) = cache::upsert_rule(manager, rule) {
            error!("Failed to seed default rule: {e}");
        }
    }

    Ok(())
}
