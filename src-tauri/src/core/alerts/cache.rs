use std::collections::VecDeque;

use log::{debug, error};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::core::alerts::types::{
    AlertAction, AlertHistoryFilter, AlertHistoryPage, AlertRecord, AlertRule, AlertStats,
};
use crate::core::settings::AppSettingsManager;
use crate::utils::types::events::ALERT_FIRED;

pub fn get_all_rules(manager: &AppSettingsManager) -> Vec<AlertRule> {
    manager
        .sub_settings("alerts/rules")
        .ok()
        .and_then(|sub| sub.get_all_values().ok())
        .unwrap_or_default()
        .into_values()
        .filter_map(|v| serde_json::from_value::<AlertRule>(v).ok())
        .collect()
}

pub fn get_rule(manager: &AppSettingsManager, id: &str) -> Option<AlertRule> {
    manager
        .sub_settings("alerts/rules")
        .ok()
        .and_then(|sub| sub.get::<AlertRule>(id).ok())
}

pub fn upsert_rule(manager: &AppSettingsManager, mut rule: AlertRule) -> Result<AlertRule, String> {
    if rule.id.is_empty() {
        rule.id = uuid::Uuid::new_v4().to_string();
    }

    let sub = manager
        .sub_settings("alerts/rules")
        .map_err(|e| e.to_string())?;

    sub.set(&rule.id, &rule)
        .map_err(|e| format!("Failed to save alert rule: {e}"))?;

    Ok(rule)
}

pub fn delete_rule(manager: &AppSettingsManager, id: &str) -> Result<(), String> {
    let sub = manager
        .sub_settings("alerts/rules")
        .map_err(|e| e.to_string())?;

    sub.delete(id)
        .map_err(|e| format!("Failed to delete alert rule: {e}"))?;

    Ok(())
}

pub async fn bump_rule_fired(
    manager: &AppSettingsManager,
    cache: &AlertRuleCache,
    id: &str,
    at: chrono::DateTime<chrono::Utc>,
) {
    cache.bump_fired(manager, id, at).await;
}

pub fn get_all_actions(manager: &AppSettingsManager) -> Vec<AlertAction> {
    manager
        .sub_settings("alerts/actions")
        .ok()
        .and_then(|sub| sub.get_all_values().ok())
        .unwrap_or_default()
        .into_values()
        .filter_map(|v| serde_json::from_value::<AlertAction>(v).ok())
        .collect()
}

pub fn get_action(manager: &AppSettingsManager, id: &str) -> Option<AlertAction> {
    manager
        .sub_settings("alerts/actions")
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
        .sub_settings("alerts/actions")
        .map_err(|e| e.to_string())?;

    sub.set(&id, &action)
        .map_err(|e| format!("Failed to save alert action: {e}"))?;

    Ok(action)
}

pub fn delete_action(manager: &AppSettingsManager, id: &str) -> Result<(), String> {
    let sub = manager
        .sub_settings("alerts/actions")
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
        let rules = get_all_rules(manager);
        let mut cache = self.rules.write().await;
        *cache = rules;
        debug!("🔄 Alert rules cache reloaded ({} rules)", cache.len());
    }

    pub async fn reload_actions(&self, manager: &AppSettingsManager) {
        let actions = get_all_actions(manager);
        let mut cache = self.actions.write().await;
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
    /// Updates the in-memory cache immediately and persists the updated rule to disk.
    pub async fn bump_fired(
        &self,
        manager: &AppSettingsManager,
        id: &str,
        at: chrono::DateTime<chrono::Utc>,
    ) {
        let mut updated_rule: Option<AlertRule> = None;

        let mut rules = self.rules.write().await;
        if let Some(rule) = rules.iter_mut().find(|r| r.id == id) {
            rule.last_fired = Some(at);
            rule.fire_count += 1;
            updated_rule = Some(rule.clone());
        }

        drop(rules);

        if let Some(rule) = updated_rule
            && let Err(e) = upsert_rule(manager, rule)
        {
            error!("Failed to persist alert rule firing: {e}");
        }
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

    pub async fn push(&self, record: AlertRecord, app: Option<&AppHandle>) {
        if let Some(app) = app {
            let _ = app.emit(ALERT_FIRED, &record);
        }
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

    pub async fn unacknowledged_count(&self) -> usize {
        self.records
            .read()
            .await
            .iter()
            .filter(|r| !r.acknowledged)
            .count()
    }

    pub async fn get_stats(&self) -> AlertStats {
        let records = self.records.read().await;
        let mut by_severity = std::collections::HashMap::new();
        let mut by_rule = std::collections::HashMap::new();

        for r in records.iter() {
            *by_severity.entry(r.severity.clone()).or_insert(0) += 1;
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
