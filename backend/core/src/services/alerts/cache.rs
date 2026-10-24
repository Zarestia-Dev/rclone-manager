use std::collections::VecDeque;

use log::{debug, error};
use tokio::sync::RwLock;

use crate::services::alerts::types::{
    AlertAction, AlertHistoryFilter, AlertHistoryPage, AlertRecord, AlertRule, AlertStats,
};
use crate::services::settings::AppSettingsManager;
use crate::utils::types::events::ALERT_FIRED;

pub fn get_all_rules(manager: &AppSettingsManager) -> Vec<AlertRule> {
    manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_RULES)
        .ok()
        .and_then(|sub| sub.get_all_values().ok())
        .unwrap_or_default()
        .into_values()
        .filter_map(|v| serde_json::from_value::<AlertRule>(v).ok())
        .collect()
}

#[cfg(feature = "notifications")]
pub fn get_rule(manager: &AppSettingsManager, id: &str) -> Option<AlertRule> {
    manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_RULES)
        .ok()
        .and_then(|sub| sub.get::<AlertRule>(id).ok())
}

pub fn upsert_rule(manager: &AppSettingsManager, mut rule: AlertRule) -> Result<AlertRule, String> {
    if rule.id.is_empty() {
        rule.id = uuid::Uuid::new_v4().to_string();
    }

    let sub = manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_RULES)
        .map_err(|e| e.to_string())?;

    sub.set(&rule.id, &rule)
        .map_err(|e| format!("Failed to save alert rule: {e}"))?;

    Ok(rule)
}

pub fn delete_rule(manager: &AppSettingsManager, id: &str) -> Result<(), String> {
    let sub = manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_RULES)
        .map_err(|e| e.to_string())?;

    sub.delete(id)
        .map_err(|e| format!("Failed to delete alert rule: {e}"))?;

    Ok(())
}

// Persist only runtime metadata; do not overwrite edited rules or recreate deleted ones.
fn persist_firing(manager: &AppSettingsManager, fired: &AlertRule) -> rcman::Result<()> {
    let sub = manager.sub_settings(crate::utils::constants::SUB_ALERTS_RULES)?;
    let mut stored: AlertRule = match sub.get(&fired.id) {
        Ok(rule) => rule,
        Err(rcman::Error::SubSettingsEntryNotFound(_)) => return Ok(()),
        Err(error) => return Err(error),
    };
    if stored.fire_count >= fired.fire_count {
        return Ok(());
    }
    stored.fire_count = fired.fire_count;
    stored.last_fired = fired.last_fired;
    sub.set(&stored.id, &stored)
}

pub fn get_all_actions(manager: &AppSettingsManager) -> Vec<AlertAction> {
    manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_ACTIONS)
        .ok()
        .and_then(|sub| sub.get_all_values().ok())
        .unwrap_or_default()
        .into_values()
        .filter_map(|v| serde_json::from_value::<AlertAction>(v).ok())
        .collect()
}

#[cfg(feature = "notifications")]
pub fn get_action(manager: &AppSettingsManager, id: &str) -> Option<AlertAction> {
    manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_ACTIONS)
        .ok()
        .and_then(|sub| sub.get::<AlertAction>(id).ok())
}

pub fn upsert_action(
    manager: &AppSettingsManager,
    mut action: AlertAction,
) -> Result<AlertAction, String> {
    if action.id().is_empty() {
        action.common_mut().id = uuid::Uuid::new_v4().to_string();
    }

    let id = action.id().to_string();
    let sub = manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_ACTIONS)
        .map_err(|e| e.to_string())?;

    sub.set(&id, &action)
        .map_err(|e| format!("Failed to save alert action: {e}"))?;

    Ok(action)
}

pub fn delete_action(manager: &AppSettingsManager, id: &str) -> Result<(), String> {
    let sub = manager
        .sub_settings(crate::utils::constants::SUB_ALERTS_ACTIONS)
        .map_err(|e| e.to_string())?;

    sub.delete(id)
        .map_err(|e| format!("Failed to delete alert action: {e}"))?;

    debug!("🗑️ Deleted alert action: {id}");

    Ok(())
}

/// In-memory cache for alert rules and actions to avoid frequent disk I/O.
#[derive(Clone)]
pub struct AlertRuleCache {
    rules: std::sync::Arc<RwLock<Vec<AlertRule>>>,
    actions: std::sync::Arc<RwLock<Vec<AlertAction>>>,
}

impl AlertRuleCache {
    pub fn new(manager: &AppSettingsManager) -> Self {
        let rules = get_all_rules(manager);
        let actions = get_all_actions(manager);
        Self {
            rules: std::sync::Arc::new(RwLock::new(rules)),
            actions: std::sync::Arc::new(RwLock::new(actions)),
        }
    }

    pub async fn reload_rules(&self, manager: &AppSettingsManager) {
        let mut cache = self.rules.write().await;
        if manager.is_locked() {
            return;
        }
        let rules = get_all_rules(manager);
        if manager.is_locked() {
            return;
        }
        *cache = rules;
        debug!("🔄 Alert rules cache reloaded ({} rules)", cache.len());
    }

    pub async fn reload_actions(&self, manager: &AppSettingsManager) {
        let mut cache = self.actions.write().await;
        if manager.is_locked() {
            return;
        }
        let actions = get_all_actions(manager);
        if manager.is_locked() {
            return;
        }
        *cache = actions;
        debug!("🔄 Alert actions cache reloaded ({} actions)", cache.len());
    }

    pub async fn get_rules(&self) -> Vec<AlertRule> {
        self.rules.read().await.clone()
    }

    pub async fn get_actions(&self) -> Vec<AlertAction> {
        self.actions.read().await.clone()
    }

    pub async fn get_action(&self, id: &str) -> Option<AlertAction> {
        self.actions
            .read()
            .await
            .iter()
            .find(|a| a.id() == id)
            .cloned()
    }

    /// Increments the fire count and updates the last fired timestamp for a rule.
    /// Keep cooldown/count state in the existing cache while Vault is locked.
    pub async fn bump_fired(
        &self,
        manager: &AppSettingsManager,
        id: &str,
        at: chrono::DateTime<chrono::Utc>,
    ) {
        let mut rules = self.rules.write().await;
        if let Some(rule) = rules.iter_mut().find(|r| r.id == id) {
            rule.last_fired = Some(at);
            rule.fire_count += 1;
            if !manager.is_locked()
                && let Err(error) = persist_firing(manager, rule)
                && !matches!(error, rcman::Error::ConfigLocked)
            {
                error!("Failed to persist alert rule firing: {error}");
            }
        }
    }

    /// Called from the Vault blocking worker before frontend access is reopened.
    pub(crate) fn flush_firings(&self, manager: &AppSettingsManager) -> rcman::Result<()> {
        let rules = self.rules.blocking_read();
        for rule in rules.iter() {
            persist_firing(manager, rule)?;
        }
        Ok(())
    }
}

pub struct AlertHistoryCache {
    records: RwLock<VecDeque<AlertRecord>>,
    max_entries: usize,
}

impl AlertHistoryCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            records: RwLock::new(VecDeque::new()),
            max_entries,
        }
    }

    pub async fn push(&self, record: AlertRecord) {
        crate::services::bridge::emit(ALERT_FIRED, &record);
        {
            let mut records = self.records.write().await;
            records.push_back(record);
            if records.len() > self.max_entries {
                records.pop_front();
            }
        }
    }

    pub async fn get_paginated(&self, filter: &AlertHistoryFilter) -> AlertHistoryPage {
        let records = self.records.read().await;

        let offset = filter.offset.unwrap_or(0);
        let limit = filter.limit.unwrap_or(50);

        let mut items: Vec<AlertRecord> = Vec::new();
        let mut total_matches: usize = 0;

        for r in records.iter().rev() {
            if let Some(sev) = &filter.severity
                && &r.severity != sev
            {
                continue;
            }
            if let Some(kind) = &filter.event_kind
                && &r.event_kind != kind
            {
                continue;
            }
            if let Some(remote) = &filter.remote
                && r.remote.as_deref() != Some(remote.as_str())
            {
                continue;
            }
            if let Some(acked) = filter.acknowledged
                && r.acknowledged != acked
            {
                continue;
            }
            if let Some(rule_id) = &filter.rule_id
                && &r.rule_id != rule_id
            {
                continue;
            }
            if let Some(origins) = &filter.origins {
                let origin_matches = r.origin.as_ref().map_or_else(
                    || origins.contains(&crate::utils::types::origin::Origin::Internal),
                    |o| origins.contains(o),
                );
                if !origin_matches {
                    continue;
                }
            }
            if let Some(from) = filter.from_ts
                && r.timestamp < from
            {
                continue;
            }
            if let Some(to) = filter.to_ts
                && r.timestamp > to
            {
                continue;
            }

            // matched
            if total_matches >= offset && items.len() < limit {
                items.push(r.clone());
            }
            total_matches += 1;
        }

        AlertHistoryPage {
            items,
            total: total_matches,
            offset,
            limit,
        }
    }

    pub async fn acknowledge(&self, id: &str) -> Result<(), String> {
        let mut records = self.records.write().await;
        let record = records
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or_else(|| format!("Alert record '{id}' not found"))?;
        record.acknowledged = true;
        record.ack_at = Some(chrono::Utc::now());
        Ok(())
    }

    pub async fn acknowledge_all(&self) {
        let now = chrono::Utc::now();
        let mut records = self.records.write().await;
        for r in records.iter_mut().filter(|r| !r.acknowledged) {
            r.acknowledged = true;
            r.ack_at = Some(now);
        }
    }

    pub async fn clear(&self) {
        self.records.write().await.clear();
    }

    pub async fn get_stats(&self) -> AlertStats {
        let records = self.records.read().await;
        let mut by_severity = std::collections::HashMap::new();
        let mut by_rule = std::collections::HashMap::new();

        for r in records.iter() {
            *by_severity.entry(r.severity).or_insert(0) += 1;
            *by_rule.entry(r.rule_name.clone()).or_insert(0) += 1;
        }

        AlertStats {
            total_fired: records.len(),
            unacknowledged: records.iter().filter(|r| !r.acknowledged).count(),
            by_severity,
            by_rule,
        }
    }
}

impl Default for AlertHistoryCache {
    fn default() -> Self {
        Self::new(10_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{alerts::types::ScriptAction, settings::schema::AppSettings};
    use crate::utils::constants::{SUB_ALERTS_ACTIONS, SUB_ALERTS_RULES};
    use std::sync::Arc;

    fn setup(vault_enabled: bool) -> (tempfile::TempDir, Arc<AppSettingsManager>, AlertRuleCache) {
        let directory = tempfile::tempdir().unwrap();
        let manager = rcman::SettingsManager::builder("alert-vault-test", "1")
            .with_config_dir(directory.path())
            .with_vault()
            .with_schema::<AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_ALERTS_RULES))
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_ALERTS_ACTIONS))
            .build()
            .unwrap();
        upsert_rule(
            &manager,
            AlertRule {
                id: "rule".into(),
                name: "Original rule".into(),
                enabled: true,
                cooldown_secs: 60,
                max_fire_count: 2,
                action_ids: vec!["action".into()],
                ..Default::default()
            },
        )
        .unwrap();
        let mut action = AlertAction::Script(ScriptAction::default());
        action.common_mut().id = "action".into();
        upsert_action(&manager, action).unwrap();
        if vault_enabled {
            manager.enable_vault("password").unwrap();
        }
        let cache = AlertRuleCache::new(&manager);
        (directory, Arc::new(manager), cache)
    }

    #[tokio::test]
    async fn locked_firings_and_reloads_keep_runtime_limits_and_actions() {
        let (_directory, manager, cache) = setup(true);
        manager.lock().unwrap();
        let first = chrono::Utc::now();
        let last = first + chrono::Duration::seconds(1);
        cache.bump_fired(&manager, "rule", first).await;
        cache.bump_fired(&manager, "rule", last).await;
        cache.reload_rules(&manager).await;
        cache.reload_actions(&manager).await;
        let rules = cache.get_rules().await;
        assert_eq!(rules[0].fire_count, rules[0].max_fire_count);
        assert_eq!(rules[0].last_fired, Some(last));
        assert_eq!(rules[0].cooldown_secs, 60);
        assert!(cache.get_action("action").await.is_some());
        assert!(
            manager
                .sub_settings(SUB_ALERTS_RULES)
                .unwrap()
                .get::<AlertRule>("rule")
                .is_err()
        );
        manager.unlock("password").unwrap();
        let worker_manager = manager.clone();
        crate::utils::spawn_blocking(move || cache.flush_firings(&worker_manager))
            .await
            .unwrap()
            .unwrap();
        let stored: AlertRule = manager
            .sub_settings(SUB_ALERTS_RULES)
            .unwrap()
            .get("rule")
            .unwrap();
        assert_eq!(stored.fire_count, 2);
        assert_eq!(stored.last_fired, Some(last));
    }

    #[tokio::test]
    async fn deferred_firings_preserve_edits_and_do_not_restore_deleted_rules() {
        let (_directory, manager, cache) = setup(true);
        manager.lock().unwrap();
        cache.bump_fired(&manager, "rule", chrono::Utc::now()).await;
        manager.unlock("password").unwrap();
        let sub = manager.sub_settings(SUB_ALERTS_RULES).unwrap();
        let mut edited: AlertRule = sub.get("rule").unwrap();
        edited.name = "Edited rule".into();
        edited.cooldown_secs = 120;
        sub.set("rule", &edited).unwrap();
        let worker_manager = manager.clone();
        let worker_cache = cache.clone();
        crate::utils::spawn_blocking(move || worker_cache.flush_firings(&worker_manager))
            .await
            .unwrap()
            .unwrap();
        let stored: AlertRule = sub.get("rule").unwrap();
        assert_eq!(stored.name, "Edited rule");
        assert_eq!(stored.cooldown_secs, 120);
        assert_eq!(stored.fire_count, 1);
        manager.lock().unwrap();
        cache.bump_fired(&manager, "rule", chrono::Utc::now()).await;
        manager.unlock("password").unwrap();
        sub.delete("rule").unwrap();
        let worker_manager = manager.clone();
        crate::utils::spawn_blocking(move || cache.flush_firings(&worker_manager))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            sub.get::<AlertRule>("rule"),
            Err(rcman::Error::SubSettingsEntryNotFound(_))
        ));
    }

    #[tokio::test]
    async fn firings_are_persisted_immediately_without_vault() {
        let (_directory, manager, cache) = setup(false);
        cache.bump_fired(&manager, "rule", chrono::Utc::now()).await;
        let stored: AlertRule = manager
            .sub_settings(SUB_ALERTS_RULES)
            .unwrap()
            .get("rule")
            .unwrap();
        assert_eq!(stored.fire_count, 1);
        cache.reload_rules(&manager).await;
        assert_eq!(cache.get_rules().await[0].fire_count, 1);
    }

    #[tokio::test]
    async fn unknown_rule_firings_do_not_change_existing_rules_or_create_settings() {
        let (_directory, manager, cache) = setup(false);
        let original = cache.get_rules().await;
        for id in ["", "missing", "旅行 & arşiv"] {
            cache.bump_fired(&manager, id, chrono::Utc::now()).await;
        }
        let rules = cache.get_rules().await;
        assert_eq!(rules.len(), original.len());
        assert_eq!(rules[0].fire_count, original[0].fire_count);
        assert_eq!(rules[0].last_fired, original[0].last_fired);
        let stored = get_all_rules(&manager);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "rule");
        assert_eq!(stored[0].fire_count, 0);
        assert!(stored[0].last_fired.is_none());
    }
}
