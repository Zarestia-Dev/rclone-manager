use std::collections::HashSet;

use chrono::Utc;
use tauri::{AppHandle, Manager};

use crate::core::alerts::dispatch;
use crate::core::alerts::{
    cache::{self, AlertHistoryCache},
    dispatch::DispatchContext,
    template::TemplateContext,
    types::{AlertAction, AlertHistoryFilter, AlertHistoryPage, AlertRule, AlertStats},
};
use crate::core::settings::AppSettingsManager;

async fn prune_unused_mqtt_connections(app: &AppHandle) {
    let cache = app.state::<cache::AlertRuleCache>();
    let dispatch_ctx = app.state::<DispatchContext>();

    let rules = cache.get_rules().await;
    let actions = cache.get_actions().await;

    let mut referenced_action_ids = HashSet::new();
    for rule in rules.iter().filter(|r| r.enabled) {
        referenced_action_ids.extend(rule.action_ids.iter().cloned());
    }

    let active_mqtt_action_ids: HashSet<String> = actions
        .iter()
        .filter_map(|action| match action {
            AlertAction::Mqtt(_)
                if action.is_enabled() && referenced_action_ids.contains(action.id()) =>
            {
                Some(action.id().to_string())
            }
            _ => None,
        })
        .collect();

    dispatch_ctx
        .mqtt_registry
        .prune_to_action_ids(&active_mqtt_action_ids)
        .await;
}

#[tauri::command]
pub async fn get_alert_rules(app: AppHandle) -> Result<Vec<AlertRule>, String> {
    let cache = app.state::<cache::AlertRuleCache>();
    Ok(cache.get_rules().await)
}

#[tauri::command]
pub async fn save_alert_rule(app: AppHandle, mut rule: AlertRule) -> Result<AlertRule, String> {
    let manager = app.state::<AppSettingsManager>();
    let cache = app.state::<cache::AlertRuleCache>();

    // Merge runtime state from cache to avoid overwriting it with stale data from UI
    {
        let rules = cache.get_rules().await;
        if let Some(existing) = rules.iter().find(|r| r.id == rule.id) {
            rule.fire_count = existing.fire_count;
            rule.last_fired = existing.last_fired;
        }
    }

    let result = cache::upsert_rule(&manager, rule)?;
    cache.reload_rules(&manager).await;
    prune_unused_mqtt_connections(&app).await;

    Ok(result)
}

#[tauri::command]
pub async fn delete_alert_rule(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    cache::delete_rule(&manager, &id)?;

    let cache = app.state::<cache::AlertRuleCache>();
    cache.reload_rules(&manager).await;
    prune_unused_mqtt_connections(&app).await;

    Ok(())
}

#[tauri::command]
pub async fn toggle_alert_rule(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<AlertRule, String> {
    let manager = app.state::<AppSettingsManager>();
    let cache = app.state::<cache::AlertRuleCache>();

    let mut rule = {
        let rules = cache.get_rules().await;
        rules.iter().find(|r| r.id == id).cloned()
    }
    .ok_or_else(|| format!("Alert rule '{id}' not found"))?;

    rule.enabled = enabled;
    let result = cache::upsert_rule(&manager, rule)?;
    cache.reload_rules(&manager).await;
    prune_unused_mqtt_connections(&app).await;

    Ok(result)
}

#[tauri::command]
pub async fn get_alert_actions(app: AppHandle) -> Result<Vec<AlertAction>, String> {
    let cache = app.state::<cache::AlertRuleCache>();
    let mut actions = cache.get_actions().await;
    actions.sort_by(|a, b| a.name().cmp(b.name()));
    Ok(actions)
}

#[tauri::command]
pub async fn save_alert_action(app: AppHandle, action: AlertAction) -> Result<AlertAction, String> {
    let manager = app.state::<AppSettingsManager>();
    let result = cache::upsert_action(&manager, action)?;

    let cache = app.state::<cache::AlertRuleCache>();
    cache.reload_actions(&manager).await;
    prune_unused_mqtt_connections(&app).await;

    Ok(result)
}

#[tauri::command]
pub async fn delete_alert_action(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    cache::delete_action(&manager, &id)?;

    let cache = app.state::<cache::AlertRuleCache>();
    cache.reload_actions(&manager).await;
    prune_unused_mqtt_connections(&app).await;

    Ok(())
}

#[tauri::command]
pub async fn test_alert_action(app: AppHandle, id: String) -> Result<bool, String> {
    let cache = app.state::<cache::AlertRuleCache>();
    let action = cache
        .get_action(&id)
        .await
        .ok_or_else(|| format!("Alert action '{id}' not found"))?;

    let ctx = TemplateContext {
        title: "Test Alert".to_string(),
        body: "This is a test alert from rclone-manager.".to_string(),
        severity: "high".to_string(),
        severity_code: 4,
        event_kind: "job_failed".to_string(),
        remote: "test-remote:".to_string(),
        profile: "test-profile".to_string(),
        backend: "test-backend".to_string(),
        operation: "Sync".to_string(),
        origin: crate::utils::types::origin::Origin::Internal,
        timestamp: Utc::now().to_rfc3339(),
        rule_id: "test-rule-id".to_string(),
        rule_name: "Test Rule".to_string(),
        source: Some("/path/to/source".to_string()),
        destination: Some("remote:/path/to/dest".to_string()),
    };

    let dispatch_ctx = app.state::<DispatchContext>();

    match action {
        AlertAction::OsToast(_) => dispatch::os_toast::dispatch(&app, &ctx)?,
        AlertAction::Webhook(ref a) => {
            let client = if a.tls_verify {
                &dispatch_ctx.client
            } else {
                &dispatch_ctx.insecure_client
            };
            dispatch::webhook::dispatch(a, &ctx, client).await?;
        }
        AlertAction::Script(ref a) => dispatch::script::dispatch(a, &ctx).await?,
        AlertAction::Telegram(ref a) => {
            dispatch::telegram::dispatch(a, &ctx, &dispatch_ctx.client).await?
        }
        AlertAction::Mqtt(ref a) => dispatch::mqtt::dispatch(a, &ctx, &dispatch_ctx).await?,
        AlertAction::Email(ref a) => dispatch::email::dispatch(a, &ctx).await?,
    }

    Ok(true)
}

#[tauri::command]
pub async fn get_alert_history(
    app: AppHandle,
    filter: Option<AlertHistoryFilter>,
) -> Result<AlertHistoryPage, String> {
    let cache = app.state::<AlertHistoryCache>();
    let filter = filter.unwrap_or_default();
    Ok(cache.get_paginated(&filter).await)
}

#[tauri::command]
pub async fn acknowledge_alert(app: AppHandle, id: String) -> Result<(), String> {
    let cache = app.state::<AlertHistoryCache>();
    cache.acknowledge(&id).await
}

#[tauri::command]
pub async fn acknowledge_all_alerts(app: AppHandle) -> Result<(), String> {
    let cache = app.state::<AlertHistoryCache>();
    cache.acknowledge_all().await;
    Ok(())
}

#[tauri::command]
pub async fn clear_alert_history(app: AppHandle) -> Result<(), String> {
    let cache = app.state::<AlertHistoryCache>();
    cache.clear().await;
    Ok(())
}

#[tauri::command]
pub async fn get_alert_stats(app: AppHandle) -> Result<AlertStats, String> {
    let cache = app.state::<AlertHistoryCache>();
    Ok(cache.get_stats().await)
}

#[tauri::command]
pub async fn get_unacknowledged_alert_count(app: AppHandle) -> Result<usize, String> {
    let cache = app.state::<AlertHistoryCache>();
    Ok(cache.unacknowledged_count().await)
}

#[tauri::command]
pub fn get_alert_template_keys() -> Vec<String> {
    crate::core::alerts::template::TemplateContext::get_available_keys()
}
