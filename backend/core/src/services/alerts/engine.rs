use std::sync::OnceLock;

use crate::context::AppHandle;
use chrono::{Duration, Utc};
use futures::future::join_all;
use log::{debug, error, warn};
use tokio::sync::mpsc;

use crate::{
    services::{
        alerts::{
            cache::{self, AlertHistoryCache},
            dispatch::{self, DispatchContext},
            template::TemplateContext,
            types::{
                ActionResult, AlertAction, AlertDetails, AlertEventKind, AlertRecord, AlertRule,
            },
        },
        settings::AppSettingsManager,
    },
    utils::{app::notification::NotificationEvent, types::origin::Origin},
};

struct AlertRequest {
    app: AppHandle,
    event: NotificationEvent,
    title: String,
    body: String,
    /// The event is a job an automation runs, which the automation announces as well.
    automation_job: bool,
}

static ALERT_CHANNEL: OnceLock<mpsc::Sender<AlertRequest>> = OnceLock::new();

/// Initialize the alert engine worker task.
pub fn init(app: AppHandle) {
    let (tx, mut rx) = mpsc::channel::<AlertRequest>(256);
    if ALERT_CHANNEL.set(tx).is_err() {
        warn!("Alert engine already initialized");
        return;
    }

    crate::utils::spawn(async move {
        debug!("Alert engine worker started");
        let ctx = app.state::<DispatchContext>().inner().clone();
        while let Some(req) = rx.recv().await {
            process_internal(req, &ctx).await;
        }
    });
}

/// Process a `NotificationEvent` through the alert engine. `automation_job` marks the event
/// of a job an automation runs, which the automation announces as well.
pub fn process(
    app: &AppHandle,
    event: &NotificationEvent,
    title: String,
    body: String,
    automation_job: bool,
) {
    if let Some(tx) = ALERT_CHANNEL.get() {
        let req = AlertRequest {
            app: app.clone(),
            event: event.clone(),
            title: title.clone(),
            body,
            automation_job,
        };

        if let Err(e) = tx.try_send(req) {
            warn!("Alert queue full, dropping alert: {title}. Error: {e}");
        }
    } else {
        warn!("Alert engine not initialized, dropping alert: {title}");
    }
}

/// Whether the rule also takes the announcement an automation makes of its own run: then the
/// job's own notification would only repeat it. A rule that filters on the job's own kind,
/// origin or text keeps it.
fn takes_automation_announcement(rule: &AlertRule) -> bool {
    (rule.event_filter.is_empty() || rule.event_filter.contains(&AlertEventKind::Automation))
        && (rule.origin_filter.is_empty() || rule.origin_filter.contains(&Origin::Automation))
        && rule.body_filter.is_none()
}

async fn process_internal(req: AlertRequest, dispatch_ctx: &DispatchContext) {
    let AlertRequest {
        app,
        event,
        title,
        body,
        automation_job,
    } = req;

    let severity = event.alert_severity();
    let kind = event.alert_kind();
    let meta = event.alert_meta();
    let remote = meta.remote;
    let profile = meta.profile;
    let backend = meta.backend;
    let operation = event.alert_operation();
    let origin = event.alert_origin();

    let manager = match app.try_state::<AppSettingsManager>() {
        Some(m) => m,
        None => return,
    };

    let manager = manager.inner();
    let alert_cache = app.state::<cache::AlertRuleCache>();
    let rules = alert_cache.get_rules().await;
    let enabled_rules: Vec<_> = rules.into_iter().filter(|r| r.enabled).collect();

    if enabled_rules.is_empty() {
        return;
    }

    let all_actions = alert_cache.get_actions().await;

    for rule in enabled_rules {
        if severity < rule.severity_min {
            continue;
        }

        if !rule.event_filter.is_empty() && !rule.event_filter.contains(&kind) {
            continue;
        }

        if automation_job && takes_automation_announcement(&rule) {
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

        if !rule.workflow_filter.is_empty() {
            let matches = profile
                .as_deref()
                .is_some_and(|wf| rule.workflow_filter.iter().any(|f| f == wf));
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
        alert_cache.bump_fired(manager, &rule.id, fired_at).await;

        debug!(
            "Rule '{}' matched - dispatching {} action(s)",
            rule.name,
            rule.action_ids.len()
        );

        let source = event.alert_source();
        let destination = event.alert_destination();

        let ctx = TemplateContext {
            title: title.clone(),
            body: body.clone(),
            severity: severity.as_str().to_string(),
            severity_code: severity.as_code(),
            event_kind: kind.as_str().to_string(),
            remote: remote.clone().unwrap_or_default(),
            profile: profile.clone().unwrap_or_default(),
            backend: backend.clone().unwrap_or_default(),
            operation: operation.clone().unwrap_or_default(),
            origin: origin.clone(),
            timestamp: fired_at.to_rfc3339(),
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            source: source.clone(),
            destination: destination.clone(),
        };

        let mut action_futures = vec![];

        for action_id in &rule.action_ids {
            let action = match all_actions.iter().find(|a| a.id() == action_id) {
                Some(a) if a.is_enabled() => a.clone(),
                Some(_) => continue,
                None => {
                    debug!("Action '{}' in rule '{}' not found", action_id, rule.name);
                    continue;
                }
            };

            action_futures.push(crate::utils::spawn({
                let action_app = app.clone();
                let action_ctx = ctx.clone();
                let action_dispatch_ctx = dispatch_ctx.clone();
                let client = match &action {
                    AlertAction::Webhook(a) if !a.tls_verify => {
                        dispatch_ctx.insecure_client.clone()
                    }
                    _ => dispatch_ctx.client.clone(),
                };

                async move {
                    let start = std::time::Instant::now();
                    let result = execute_action(
                        &action_app,
                        &action,
                        &action_ctx,
                        &client,
                        &action_dispatch_ctx,
                    )
                    .await;
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
                severity,
                title: title.clone(),
                body: body.clone(),
                remote: remote.clone(),
                profile: profile.clone(),
                backend: backend.clone(),
                operation: operation.clone(),
                origin: Some(origin.clone()),
                source: source.clone(),
                destination: destination.clone(),
            },
        );
        record.action_results = action_results;

        let history_cache = app.state::<AlertHistoryCache>();
        history_cache.push(record).await;
    }
}

pub async fn execute_action(
    _app: &AppHandle,
    action: &AlertAction,
    ctx: &TemplateContext,
    client: &reqwest::Client,
    dispatch_ctx: &DispatchContext,
) -> Result<(), String> {
    match action {
        #[cfg(feature = "notifications")]
        AlertAction::OsToast(_) => _app.host().notify(ctx),
        AlertAction::Webhook(a) => dispatch::webhook::dispatch(a, ctx, client).await,
        AlertAction::Script(a) => dispatch::script::dispatch(a, ctx).await,
        AlertAction::Telegram(a) => dispatch::telegram::dispatch(a, ctx, client).await,
        AlertAction::Whatsapp(a) => dispatch::whatsapp::dispatch(a, ctx, client).await,
        AlertAction::Mqtt(a) => dispatch::mqtt::dispatch(a, ctx, dispatch_ctx).await,
        AlertAction::Email(a) => dispatch::email::dispatch(a, ctx).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rule_that_takes_every_event_gets_the_automation_announcement_alone() {
        assert!(takes_automation_announcement(&AlertRule::default()));
        let both = AlertRule {
            event_filter: vec![AlertEventKind::Job, AlertEventKind::Automation],
            origin_filter: vec![Origin::Automation, Origin::QuickRun],
            ..AlertRule::default()
        };
        assert!(takes_automation_announcement(&both));
    }

    #[test]
    fn a_rule_that_asks_for_the_job_itself_keeps_it() {
        for rule in [
            AlertRule {
                event_filter: vec![AlertEventKind::Job],
                ..AlertRule::default()
            },
            // A Quick Run's job has the Quick Run as its origin; the announcement has none.
            AlertRule {
                origin_filter: vec![Origin::QuickRun],
                ..AlertRule::default()
            },
            // The two texts differ, so a text filter may match only the job's.
            AlertRule {
                body_filter: Some("Documents".into()),
                ..AlertRule::default()
            },
        ] {
            assert!(!takes_automation_announcement(&rule));
        }
    }
}
