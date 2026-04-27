use std::collections::HashMap;

use handlebars::Handlebars;
use log::warn;
use once_cell::sync::Lazy;
use serde_json::json;

static HBS: Lazy<Handlebars<'static>> = Lazy::new(|| {
    let mut hbs = Handlebars::new();
    hbs.set_strict_mode(false);
    hbs
});

#[derive(Debug, Clone)]
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
}

impl TemplateContext {
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
        ]
    }

    pub fn render(&self, template: &str) -> String {
        let data = json!({
            "title":         self.title,
            "body":          self.body,
            "severity":      self.severity,
            "severity_code": self.severity_code,
            "event_kind":    self.event_kind,
            "remote":        self.remote,
            "profile":       self.profile,
            "backend":       self.backend,
            "operation":     self.operation,
            "origin":        self.origin,
            "timestamp":     self.timestamp,
            "rule_id":       self.rule_id,
            "rule_name":     self.rule_name,
        });

        match HBS.render_template(template, &data) {
            Ok(rendered) => rendered,
            Err(e) => {
                warn!("Alert template render failed: {e}");
                template.to_string()
            }
        }
    }
}
