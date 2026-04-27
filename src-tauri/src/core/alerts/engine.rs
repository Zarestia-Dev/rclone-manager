use chrono::{Duration, Utc};
use futures::future::join_all;
use log::{debug, error, warn};
use tauri::{AppHandle, Manager};

use crate::core::alerts::{
    cache::{self, AlertHistoryCache},
    dispatch,
    event_ext::NotificationEventExt,
    template::TemplateContext,
    types::{ActionResult, AlertAction, AlertDetails, AlertEventKind, AlertRecord},
};
use crate::core::settings::AppSettingsManager;
use crate::utils::app::notification::NotificationEvent;
use crate::utils::types::core::RcloneState;

/// Process a `NotificationEvent` through the alert engine.
pub fn process(app: &AppHandle, event: &NotificationEvent, title: String, body: String) {
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

    let http_client = match app.try_state::<RcloneState>() {
        Some(state) => state.client.clone(),
        None => reqwest::Client::new(),
    };

    for rule in enabled_rules {
        if severity < rule.severity_min {
            continue;
        }

        if !rule.event_filter.is_empty()
            && !rule.event_filter.contains(&AlertEventKind::Any)
            && !rule.event_filter.contains(&kind)
        {
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

        if rule.cooldown_secs > 0
            && let Some(last) = rule.last_fired
            && Utc::now() - last < Duration::seconds(rule.cooldown_secs as i64)
        {
            debug!("Rule '{}' suppressed by cooldown", rule.name);
            continue;
        }

        cache::bump_rule_fired(&manager, &rule.id, Utc::now());

        debug!(
            "Rule '{}' matched - dispatching {} action(s)",
            rule.name,
            rule.action_ids.len()
        );

        // Prepare context for the spawned task
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
            timestamp: Utc::now().to_rfc3339(),
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
        };

        let app_clone = app.clone();
        let rule_clone = rule.clone();
        let http_client_clone = http_client.clone();

        let record_kind = kind.clone();
        let record_sev = severity.clone();
        let record_rem = remote.clone();
        let record_prof = profile.clone();
        let record_back = backend.clone();
        let record_oper = operation.clone();
        let record_orig = origin.clone();
        let record_title = title.clone();
        let record_body = body.clone();

        // Spawning the rule execution prevents blocking the engine loop
        tokio::spawn(async move {
            let mut action_futures = vec![];
            let manager = app_clone.state::<AppSettingsManager>();

            for action_id in &rule_clone.action_ids {
                let action = match cache::get_action(&manager, action_id) {
                    Some(a) if a.is_enabled() => a,
                    Some(_) => continue,
                    None => {
                        warn!(
                            "Action '{}' in rule '{}' not found",
                            action_id, rule_clone.name
                        );
                        continue;
                    }
                };

                let action_ctx = ctx.clone();
                let action_app = app_clone.clone();
                let action_http = http_client_clone.clone();

                // Spawn concurrent execution for each action to prevent slow webhooks/scripts from bottlenecking
                action_futures.push(tokio::spawn(async move {
                    let start = std::time::Instant::now();
                    let result =
                        execute_action(&action_app, &action, &action_ctx, &action_http).await;
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
                }));
            }

            // Await all parallel actions
            let action_results: Vec<ActionResult> = join_all(action_futures)
                .await
                .into_iter()
                .filter_map(std::result::Result::ok)
                .collect();

            let mut record = AlertRecord::new(
                &rule_clone,
                AlertDetails {
                    event_kind: record_kind,
                    severity: record_sev,
                    title: record_title,
                    body: record_body,
                    remote: record_rem,
                    profile: record_prof,
                    backend: record_back,
                    operation: record_oper,
                    origin: Some(record_orig),
                },
            );
            record.action_results = action_results;

            let history_cache = app_clone.state::<AlertHistoryCache>();
            history_cache.push(record, Some(&app_clone)).await;
        });
    }
}

async fn execute_action(
    app: &AppHandle,
    action: &AlertAction,
    ctx: &TemplateContext,
    http_client: &reqwest::Client,
) -> Result<(), String> {
    match action {
        AlertAction::OsToast(a) => dispatch::os_toast::dispatch(app, a, ctx),
        AlertAction::Webhook(a) => dispatch::webhook::dispatch(http_client, a, ctx).await,
        AlertAction::Script(a) => dispatch::script::dispatch(a, ctx).await,
    }
}
