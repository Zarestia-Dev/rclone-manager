pub mod backup;
pub mod manager;
pub mod migration;
pub mod operations;
pub mod rclone_backend;
pub mod remote;
pub mod schema;

use schema::AppSettings;

/// Type alias for the application's settings manager
/// Uses rcman's `JsonManager` convenience alias with our `AppSettings` schema
pub type AppSettingsManager = rcman::JsonManager<AppSettings>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::alerts::{
        cache::AlertRuleCache,
        types::{ActionCommon, AlertAction, OsToastAction},
    };
    use tempfile::TempDir;

    fn test_action(id: &str, name: &str) -> AlertAction {
        AlertAction::OsToast(OsToastAction {
            common: ActionCommon {
                id: id.to_string(),
                name: name.to_string(),
                enabled: true,
            },
        })
    }

    fn test_manager() -> (TempDir, AppSettingsManager) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<AppSettings>()
            .build();
        let manager = rcman::SettingsManager::new(config).expect("Failed to create manager");

        manager
            .register_sub_settings(rcman::SubSettingsConfig::singlefile("alerts/actions"))
            .expect("Failed to register alert actions sub-settings");

        (temp_dir, manager)
    }

    #[tokio::test]
    async fn alert_rule_cache_get_actions_returns_owned_copy() {
        let (_temp_dir, manager) = test_manager();

        let action = test_action("action-1", "Original Action");
        manager
            .sub_settings("alerts/actions")
            .expect("Missing alert actions sub-settings")
            .set(action.id(), &action)
            .expect("Failed to seed alert action");

        let cache = AlertRuleCache::new(&manager);

        let mut actions = cache.get_actions().await;
        assert_eq!(actions.len(), 1);

        actions[0].common_mut().name = "Mutated Action".to_string();
        actions.push(test_action("action-2", "Second Action"));

        let cached_actions = cache.get_actions().await;
        assert_eq!(cached_actions.len(), 1);
        assert_eq!(cached_actions[0].name(), "Original Action");
    }
}
