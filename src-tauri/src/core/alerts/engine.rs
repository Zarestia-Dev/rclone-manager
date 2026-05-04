use chrono::{Duration, Utc};
use futures::future::join_all;
use log::{debug, error, warn};
use tauri::{AppHandle, Manager};

use crate::core::alerts::{
    cache::{self, AlertHistoryCache},
    dispatch::{self, DispatchContext},
    event_ext::NotificationEventExt,
    template::TemplateContext,
    types::{ActionResult, AlertAction, AlertDetails, AlertRecord},
};
use crate::core::settings::AppSettingsManager;
use crate::utils::app::notification::NotificationEvent;

use std::sync::OnceLock;
use tokio::sync::mpsc;

struct AlertRequest {
    app: AppHandle,
    event: NotificationEvent,
    title: String,
    body: String,
}

static ALERT_CHANNEL: OnceLock<mpsc::UnboundedSender<AlertRequest>> = OnceLock::new();

/// Initialize the alert engine worker task.
pub fn init() {
    let (tx, mut rx) = mpsc::unbounded_channel::<AlertRequest>();
    if ALERT_CHANNEL.set(tx).is_err() {
        warn!("Alert engine already initialized");
        return;
    }

    tauri::async_runtime::spawn(async move {
        debug!("Alert engine worker started");
        let ctx = DispatchContext::new();
        while let Some(req) = rx.recv().await {
            process_internal(req, &ctx).await;
        }
    });
}

/// Process a `NotificationEvent` through the alert engine.
pub fn process(app: &AppHandle, event: &NotificationEvent, title: String, body: String) {
    if let Some(tx) = ALERT_CHANNEL.get() {
        let _ = tx.send(AlertRequest {
            app: app.clone(),
            event: event.clone(),
            title,
            body,
        });
    } else {
        warn!("Alert engine not initialized, dropping alert: {}", title);
    }
}

async fn process_internal(req: AlertRequest, dispatch_ctx: &DispatchContext) {
    let AlertRequest {
        app,
        event,
        title,
        body,
    } = req;

    let severity = event.alert_severity();
    let kind = event.alert_kind();
    let remote = event.alert_remote();
    let profile = event.alert_profile();
    let backend = event.alert_backend();
    let operation = event.alert_operation();
    let origin = event.alert_origin();

    let manager = match app.try_state::<AppSettingsManager>() {
        Some(m) => m,
        None => return,
    };

    let rules = cache::get_all_rules(&manager);
    let enabled_rules: Vec<_> = rules.into_iter().filter(|r| r.enabled).collect();

    if enabled_rules.is_empty() {
        return;
    }

    for rule in enabled_rules {
        if severity < rule.severity_min {
            continue;
        }

        if !rule.event_filter.is_empty() && !rule.event_filter.contains(&kind) {
            continue;
        }

        if !rule.remote_filter.is_empty() {
            let matches = remote
                .as_deref()
                .is_some_and(|r| rule.remote_filter.iter().any(|f| f == r));
            if !matches {
                continue;
            }
        }

        if !rule.origin_filter.is_empty() && !rule.origin_filter.contains(&origin) {
            continue;
        }

        if !rule.backend_filter.is_empty() {
            let matches = backend
                .as_deref()
                .is_some_and(|b| rule.backend_filter.iter().any(|f| f == b));
            if !matches {
                continue;
            }
        }

        if !rule.profile_filter.is_empty() {
            let matches = profile
                .as_deref()
                .is_some_and(|p| rule.profile_filter.iter().any(|f| f == p));
            if !matches {
                continue;
            }
        }

        if let Some(body_filter) = &rule.body_filter
            && !body.contains(body_filter.as_str())
        {
            continue;
        }

        if rule.cooldown_secs > 0
            && let Some(last) = rule.last_fired
            && Utc::now() - last < Duration::seconds(rule.cooldown_secs as i64)
        {
            debug!("Rule '{}' suppressed by cooldown", rule.name);
            continue;
        }

        if rule.max_fire_count > 0 && rule.fire_count >= rule.max_fire_count {
            debug!(
                "Rule '{}' suppressed: fire_count {} >= max_fire_count {}",
                rule.name, rule.fire_count, rule.max_fire_count
            );
            continue;
        }

        let fired_at = Utc::now();
        cache::bump_rule_fired(&manager, &rule.id, fired_at);

        debug!(
            "Rule '{}' matched - dispatching {} action(s)",
            rule.name,
            rule.action_ids.len()
        );

        // Prepare context
        let ctx = TemplateContext {
            title: title.clone(),
            body: body.clone(),
            severity: severity.as_str().to_string(),
            severity_code: severity.as_code(),
            event_kind: kind.as_str().to_string(),
            remote: remote.clone().unwrap_or_default(),
            profile: profile.clone().unwrap_or_else(|| "Default".to_string()),
            backend: backend.clone().unwrap_or_default(),
            operation: operation.clone().unwrap_or_default(),
            origin: origin.clone(),
            timestamp: fired_at.to_rfc3339(),
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
        };

        let mut action_futures = vec![];
        let manager_ref = app.state::<AppSettingsManager>();

        for action_id in &rule.action_ids {
            let action = match cache::get_action(&manager_ref, action_id) {
                Some(a) if a.is_enabled() => a,
                Some(_) => continue,
                None => {
                    warn!("Action '{}' in rule '{}' not found", action_id, rule.name);
                    continue;
                }
            };

            action_futures.push(tokio::spawn({
                let action_app = app.clone();
                let action_ctx = ctx.clone();
                let client = match &action {
                    AlertAction::Webhook(a) if !a.tls_verify => {
                        dispatch_ctx.insecure_client.clone()
                    }
                    _ => dispatch_ctx.client.clone(),
                };

                async move {
                    let start = std::time::Instant::now();
                    let result = execute_action(&action_app, &action, &action_ctx, &client).await;
                    let duration_ms = start.elapsed().as_millis() as u64;

                    let (success, error_msg) = match result {
                        Ok(()) => (true, None),
                        Err(e) => {
                            error!("Action '{}' failed: {e}", action.name());
                            (false, Some(e))
                        }
                    };

                    ActionResult {
                        action_id: action.id().to_string(),
                        action_name: action.name().to_string(),
                        action_kind: action.kind_str().to_string(),
                        success,
                        error: error_msg,
                        duration_ms,
                    }
                }
            }));
        }

        // Await all parallel actions for THIS rule
        let action_results: Vec<ActionResult> = join_all(action_futures)
            .await
            .into_iter()
            .filter_map(std::result::Result::ok)
            .collect();

        let mut record = AlertRecord::new(
            &rule,
            AlertDetails {
                event_kind: kind.clone(),
                severity: severity.clone(),
                title: title.clone(),
                body: body.clone(),
                remote: remote.clone(),
                profile: profile.clone(),
                backend: backend.clone(),
                operation: operation.clone(),
                origin: Some(origin.clone()),
            },
        );
        record.action_results = action_results;

        let history_cache = app.state::<AlertHistoryCache>();
        history_cache.push(record, Some(&app)).await;
    }
}

async fn execute_action(
    app: &AppHandle,
    action: &AlertAction,
    ctx: &TemplateContext,
    client: &reqwest::Client,
) -> Result<(), String> {
    match action {
        AlertAction::OsToast(_) => dispatch::os_toast::dispatch(app, ctx),
        AlertAction::Webhook(a) => dispatch::webhook::dispatch(a, ctx, client).await,
        AlertAction::Script(a) => dispatch::script::dispatch(a, ctx).await,
        AlertAction::Telegram(a) => dispatch::telegram::dispatch(a, ctx, client)
            .await
            .map(|_| ()),
        AlertAction::Mqtt(a) => dispatch::mqtt::dispatch(a, ctx).await,
        AlertAction::Email(a) => dispatch::email::dispatch(a, ctx).await,
    }
}
