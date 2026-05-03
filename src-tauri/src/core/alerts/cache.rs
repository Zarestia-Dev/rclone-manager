use crate::core::alerts::types::{
    AlertAction, AlertHistoryFilter, AlertHistoryPage, AlertRecord, AlertRule, AlertStats,
};
use crate::core::settings::AppSettingsManager;
use log::{debug, error};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

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

pub fn bump_rule_fired(manager: &AppSettingsManager, id: &str, at: chrono::DateTime<chrono::Utc>) {
    if let Some(mut rule) = get_rule(manager, id) {
        rule.last_fired = Some(at);
        rule.fire_count += 1;

        if let Err(e) = upsert_rule(manager, rule) {
            error!("Failed to persist alert rule firing: {e}");
        }
    }
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
        let new_id = uuid::Uuid::new_v4().to_string();
        match &mut action {
            AlertAction::Webhook(a) => a.id = new_id,
            AlertAction::Script(a) => a.id = new_id,
            AlertAction::OsToast(a) => a.id = new_id,
        }
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

    // Note: Any in-flight webhook clients for this action will be automatically
    // cleaned up when their dispatch completes (Rust RAII). No new dispatches
    // will be created for this deleted action.
    debug!("🗑️ Deleted alert action: {id}");

    Ok(())
}

/// Ring-buffer in-memory alert history. Memory-only, no persistence.
pub struct AlertHistoryCache {
    records: RwLock<Vec<AlertRecord>>,
    max_entries: usize,
}

impl AlertHistoryCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            records: RwLock::new(vec![]),
            max_entries,
        }
    }

    pub async fn push(&self, record: AlertRecord, app: Option<&AppHandle>) {
        if let Some(app) = app {
            let _ = app.emit(ALERT_FIRED, &record);
        }
        {
            let mut records = self.records.write().await;
            records.push(record);
            if records.len() > self.max_entries {
                records.remove(0);
            }
        }
    }

    pub async fn get_paginated(&self, filter: &AlertHistoryFilter) -> AlertHistoryPage {
        let records = self.records.read().await;

        let filtered: Vec<&AlertRecord> = records
            .iter()
            .rev()
            .filter(|r| {
                if let Some(sev_min) = &filter.severity_min
                    && &r.severity < sev_min
                {
                    return false;
                }
                if let Some(kind) = &filter.event_kind
                    && &r.event_kind != kind
                {
                    return false;
                }
                if let Some(remote) = &filter.remote
                    && r.remote.as_deref() != Some(remote.as_str())
                {
                    return false;
                }
                if let Some(acked) = filter.acknowledged
                    && r.acknowledged != acked
                {
                    return false;
                }
                if let Some(rule_id) = &filter.rule_id
                    && &r.rule_id != rule_id
                {
                    return false;
                }
                if let Some(origins) = &filter.origins {
                    let origin_matches = r.origin.as_ref().map_or_else(
                        || origins.contains(&crate::utils::types::origin::Origin::Internal),
                        |o| origins.contains(o),
                    );
                    if !origin_matches {
                        return false;
                    }
                }
                true
            })
            .collect();

        let total = filtered.len();
        let offset = filter.offset.unwrap_or(0);
        let limit = filter.limit.unwrap_or(50);

        AlertHistoryPage {
            items: filtered
                .into_iter()
                .skip(offset)
                .take(limit)
                .cloned()
                .collect(),
            total,
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
            *by_severity
                .entry(r.severity.as_str().to_string())
                .or_insert(0) += 1;
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
