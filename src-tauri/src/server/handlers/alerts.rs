use crate::core::alerts::{
    cache::{self, AlertHistoryCache},
    types::{AlertAction, AlertHistoryFilter, AlertHistoryPage, AlertRule, AlertStats},
};
use crate::core::settings::AppSettingsManager;
use crate::server::handlers::common::ApiResult;
use crate::server::state::{ApiResponse, WebServerState};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use tauri::{Emitter, Manager};

// =============================================================================
// RULES
// =============================================================================

pub async fn get_alert_rules_handler(
    State(state): State<WebServerState>,
) -> ApiResult<Vec<AlertRule>> {
    let manager = state.app_handle.state::<AppSettingsManager>();
    Ok(Json(ApiResponse::success(cache::get_all_rules(&manager))))
}

#[derive(Deserialize)]
pub struct SaveAlertRuleBody {
    pub rule: AlertRule,
}

pub async fn save_alert_rule_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveAlertRuleBody>,
) -> ApiResult<AlertRule> {
    let manager = state.app_handle.state::<AppSettingsManager>();
    let result = cache::upsert_rule(&manager, body.rule).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

pub async fn delete_alert_rule_handler(
    State(state): State<WebServerState>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    let manager = state.app_handle.state::<AppSettingsManager>();
    cache::delete_rule(&manager, &id).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
pub struct ToggleAlertRuleBody {
    pub enabled: bool,
}

pub async fn toggle_alert_rule_handler(
    State(state): State<WebServerState>,
    Path(id): Path<String>,
    Json(body): Json<ToggleAlertRuleBody>,
) -> ApiResult<AlertRule> {
    let manager = state.app_handle.state::<AppSettingsManager>();
    let mut rule = cache::get_rule(&manager, &id)
        .ok_or_else(|| format!("Alert rule '{}' not found", id))
        .map_err(anyhow::Error::msg)?;
    rule.enabled = body.enabled;
    let result = cache::upsert_rule(&manager, rule).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

// =============================================================================
// ACTIONS
// =============================================================================

pub async fn get_alert_actions_handler(
    State(state): State<WebServerState>,
) -> ApiResult<Vec<AlertAction>> {
    let manager = state.app_handle.state::<AppSettingsManager>();
    Ok(Json(ApiResponse::success(cache::get_all_actions(&manager))))
}

#[derive(Deserialize)]
pub struct SaveAlertActionBody {
    pub action: AlertAction,
}

pub async fn save_alert_action_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveAlertActionBody>,
) -> ApiResult<AlertAction> {
    let manager = state.app_handle.state::<AppSettingsManager>();
    let result = cache::upsert_action(&manager, body.action).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

pub async fn delete_alert_action_handler(
    State(state): State<WebServerState>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    let manager = state.app_handle.state::<AppSettingsManager>();
    cache::delete_action(&manager, &id).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

pub async fn test_alert_action_handler(
    State(state): State<WebServerState>,
    Path(id): Path<String>,
) -> ApiResult<bool> {
    use crate::core::alerts::dispatch;
    use crate::core::alerts::template::TemplateContext;
    use chrono::Utc;

    let manager = state.app_handle.state::<AppSettingsManager>();
    let action = cache::get_action(&manager, &id)
        .ok_or_else(|| format!("Alert action '{}' not found", id))
        .map_err(anyhow::Error::msg)?;

    let ctx = TemplateContext {
        title: "Test Alert".to_string(),
        body: "This is a test alert from rclone-manager (REST).".to_string(),
        severity: "high".to_string(),
        severity_code: 4,
        event_kind: "job_failed".to_string(),
        remote: "test-remote:".to_string(),
        operation: "Sync".to_string(),
        origin: crate::utils::types::origin::Origin::Internal,
        timestamp: Utc::now().to_rfc3339(),
        rule_id: "test-rule-id".to_string(),
        rule_name: "Test Rule".to_string(),
    };

    let http_client = {
        use crate::utils::types::core::RcloneState;
        match state.app_handle.try_state::<RcloneState>() {
            Some(s) => s.client.clone(),
            None => reqwest::Client::new(),
        }
    };

    match action {
        AlertAction::OsToast(ref a) => dispatch::os_toast::dispatch(&state.app_handle, a, &ctx)
            .await
            .map_err(anyhow::Error::msg)?,
        AlertAction::Webhook(ref a) => dispatch::webhook::dispatch(&http_client, a, &ctx)
            .await
            .map_err(anyhow::Error::msg)?,
        AlertAction::Script(ref a) => dispatch::script::dispatch(a, &ctx)
            .await
            .map_err(anyhow::Error::msg)?,
    }

    Ok(Json(ApiResponse::success(true)))
}

// =============================================================================
// HISTORY
// =============================================================================

pub async fn get_alert_history_handler(
    State(state): State<WebServerState>,
    Query(filter): Query<AlertHistoryFilter>,
) -> ApiResult<AlertHistoryPage> {
    let cache = state.app_handle.state::<AlertHistoryCache>();
    Ok(Json(ApiResponse::success(
        cache.get_paginated(&filter).await,
    )))
}

pub async fn acknowledge_alert_handler(
    State(state): State<WebServerState>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    let cache = state.app_handle.state::<AlertHistoryCache>();
    cache.acknowledge(&id).await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

pub async fn acknowledge_all_alerts_handler(State(state): State<WebServerState>) -> ApiResult<()> {
    let cache = state.app_handle.state::<AlertHistoryCache>();
    cache.acknowledge_all().await;
    Ok(Json(ApiResponse::success(())))
}

pub async fn clear_alert_history_handler(State(state): State<WebServerState>) -> ApiResult<()> {
    let cache = state.app_handle.state::<AlertHistoryCache>();
    cache.clear().await;
    Ok(Json(ApiResponse::success(())))
}

pub async fn get_alert_stats_handler(State(state): State<WebServerState>) -> ApiResult<AlertStats> {
    let cache = state.app_handle.state::<AlertHistoryCache>();
    Ok(Json(ApiResponse::success(cache.get_stats().await)))
}

pub async fn get_unacknowledged_alert_count_handler(
    State(state): State<WebServerState>,
) -> ApiResult<usize> {
    let cache = state.app_handle.state::<AlertHistoryCache>();
    Ok(Json(ApiResponse::success(
        cache.unacknowledged_count().await,
    )))
}
