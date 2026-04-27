use crate::core::alerts::{
    cache::{self, AlertHistoryCache},
    types::{AlertAction, AlertHistoryFilter, AlertHistoryPage, AlertRule, AlertStats},
};
use crate::core::settings::AppSettingsManager;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn get_alert_rules(app: AppHandle) -> Result<Vec<AlertRule>, String> {
    let manager = app.state::<AppSettingsManager>();
    Ok(cache::get_all_rules(&manager))
}

#[tauri::command]
pub async fn save_alert_rule(app: AppHandle, rule: AlertRule) -> Result<AlertRule, String> {
    let manager = app.state::<AppSettingsManager>();
    let result = cache::upsert_rule(&manager, rule)?;
    Ok(result)
}

#[tauri::command]
pub async fn delete_alert_rule(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    cache::delete_rule(&manager, &id)?;
    Ok(())
}

#[tauri::command]
pub async fn toggle_alert_rule(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<AlertRule, String> {
    let manager = app.state::<AppSettingsManager>();
    let mut rule =
        cache::get_rule(&manager, &id).ok_or_else(|| format!("Alert rule '{id}' not found"))?;
    rule.enabled = enabled;
    let result = cache::upsert_rule(&manager, rule)?;
    Ok(result)
}

#[tauri::command]
pub async fn get_alert_actions(app: AppHandle) -> Result<Vec<AlertAction>, String> {
    let manager = app.state::<AppSettingsManager>();
    Ok(cache::get_all_actions(&manager))
}

#[tauri::command]
pub async fn save_alert_action(app: AppHandle, action: AlertAction) -> Result<AlertAction, String> {
    let manager = app.state::<AppSettingsManager>();
    let result = cache::upsert_action(&manager, action)?;
    Ok(result)
}

#[tauri::command]
pub async fn delete_alert_action(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    cache::delete_action(&manager, &id)?;
    Ok(())
}

#[tauri::command]
pub async fn test_alert_action(app: AppHandle, id: String) -> Result<bool, String> {
    use crate::core::alerts::dispatch;
    use crate::core::alerts::template::TemplateContext;
    use chrono::Utc;

    let manager = app.state::<AppSettingsManager>();
    let action =
        cache::get_action(&manager, &id).ok_or_else(|| format!("Alert action '{id}' not found"))?;

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
    };

    let http_client = {
        use crate::utils::types::core::RcloneState;
        match app.try_state::<RcloneState>() {
            Some(state) => state.client.clone(),
            None => reqwest::Client::new(),
        }
    };

    match action {
        AlertAction::OsToast(ref a) => dispatch::os_toast::dispatch(&app, a, &ctx)?,
        AlertAction::Webhook(ref a) => dispatch::webhook::dispatch(&http_client, a, &ctx).await?,
        AlertAction::Script(ref a) => dispatch::script::dispatch(a, &ctx).await?,
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
