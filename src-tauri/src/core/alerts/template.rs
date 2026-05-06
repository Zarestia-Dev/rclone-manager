use std::collections::HashMap;

use handlebars::Handlebars;
use log::warn;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;

static HBS: Lazy<Handlebars<'static>> = Lazy::new(|| {
    let mut hbs = Handlebars::new();
    hbs.set_strict_mode(false);
    hbs
});

#[derive(Debug, Clone, Serialize)]
pub struct TemplateContext {
    pub title: String,
    pub body: String,
    pub severity: String,
    pub severity_code: u8,
    pub event_kind: String,
    pub remote: String,
    pub profile: String,
    pub backend: String,
    pub operation: String,
    pub origin: crate::utils::types::origin::Origin,
    pub timestamp: String,
    pub rule_id: String,
    pub rule_name: String,
    pub source: Option<String>,
    pub destination: Option<String>,
}

impl TemplateContext {
    fn to_json_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Default::default()))
    }

    fn to_render_value(&self) -> Value {
        let mut val = self.to_json_value();
        let json_str = serde_json::to_string(&val).unwrap_or_default();

        if let Value::Object(ref mut map) = val {
            map.insert("json".to_string(), Value::String(json_str));
        }

        val
    }

    pub fn to_env_map(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert("ALERT_TITLE".to_string(), self.title.clone());
        map.insert("ALERT_BODY".to_string(), self.body.clone());
        map.insert("ALERT_SEVERITY".to_string(), self.severity.clone());
        map.insert(
            "ALERT_SEVERITY_CODE".to_string(),
            self.severity_code.to_string(),
        );
        map.insert("ALERT_EVENT_KIND".to_string(), self.event_kind.clone());
        map.insert("ALERT_REMOTE".to_string(), self.remote.clone());
        map.insert("ALERT_PROFILE".to_string(), self.profile.clone());
        map.insert("ALERT_BACKEND".to_string(), self.backend.clone());
        map.insert("ALERT_OPERATION".to_string(), self.operation.clone());
        map.insert("ALERT_ORIGIN".to_string(), self.origin.as_str().to_owned());
        map.insert("ALERT_TIMESTAMP".to_string(), self.timestamp.clone());
        map.insert("ALERT_RULE_ID".to_string(), self.rule_id.clone());
        map.insert("ALERT_RULE_NAME".to_string(), self.rule_name.clone());
        map.insert(
            "ALERT_SOURCE".to_string(),
            self.source.clone().unwrap_or_default(),
        );
        map.insert(
            "ALERT_DESTINATION".to_string(),
            self.destination.clone().unwrap_or_default(),
        );

        let json_val = self.to_json_value();
        if let Ok(json_str) = serde_json::to_string(&json_val) {
            map.insert("ALERT_JSON".to_string(), json_str);
        }

        map
    }

    pub fn get_available_keys() -> Vec<String> {
        vec![
            "title".to_string(),
            "body".to_string(),
            "severity".to_string(),
            "severity_code".to_string(),
            "event_kind".to_string(),
            "remote".to_string(),
            "profile".to_string(),
            "backend".to_string(),
            "operation".to_string(),
            "origin".to_string(),
            "timestamp".to_string(),
            "rule_id".to_string(),
            "rule_name".to_string(),
            "source".to_string(),
            "destination".to_string(),
            "json".to_string(),
        ]
    }

    pub fn render(&self, template: &str) -> String {
        let data = self.to_render_value();

        match HBS.render_template(template, &data) {
            Ok(rendered) => rendered,
            Err(e) => {
                warn!("Alert template render failed: {e}");
                template.to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TemplateContext;
    use serde_json::Value;

    fn sample_context() -> TemplateContext {
        TemplateContext {
            title: "Title".to_string(),
            body: "Body".to_string(),
            severity: "warning".to_string(),
            severity_code: 2,
            event_kind: "event.kind".to_string(),
            remote: "remote".to_string(),
            profile: "profile".to_string(),
            backend: "backend".to_string(),
            operation: "upload".to_string(),
            origin: crate::utils::types::origin::Origin::Internal,
            timestamp: "2026-05-06T00:00:00Z".to_string(),
            rule_id: "rule-id".to_string(),
            rule_name: "rule-name".to_string(),
            source: Some("source".to_string()),
            destination: Some("destination".to_string()),
        }
    }

    #[test]
    fn render_exposes_json_for_templates() {
        let ctx = sample_context();
        let rendered = ctx.render(r#"{"payload": {{{json}}}}"#);

        let parsed: Value = serde_json::from_str(&rendered).expect("rendered JSON should parse");
        let expected_json = serde_json::to_string(&serde_json::json!({
            "title": "Title",
            "body": "Body",
            "severity": "warning",
            "severity_code": 2,
            "event_kind": "event.kind",
            "remote": "remote",
            "profile": "profile",
            "backend": "backend",
            "operation": "upload",
            "origin": "internal",
            "timestamp": "2026-05-06T00:00:00Z",
            "rule_id": "rule-id",
            "rule_name": "rule-name",
            "source": "source",
            "destination": "destination"
        }))
        .expect("plain context JSON should serialize");

        let expected_value: Value =
            serde_json::from_str(&expected_json).expect("plain context JSON should parse");

        assert_eq!(parsed["payload"], expected_value);
    }

    #[test]
    fn env_map_serializes_alert_json_once() {
        let ctx = sample_context();
        let env_map = ctx.to_env_map();
        let alert_json = env_map.get("ALERT_JSON").expect("ALERT_JSON should exist");

        let parsed: Value = serde_json::from_str(alert_json).expect("ALERT_JSON should parse");
        assert_eq!(parsed["title"], "Title");
        assert_eq!(parsed["body"], "Body");
        assert!(parsed.get("json").is_none());
    }
}
