//! Documentation generator for settings schema
//!
//! Generates markdown documentation from `SettingsSchema` metadata.

use crate::config::{SettingMetadata, SettingType, SettingsSchema};
use std::collections::HashMap;

/// Configuration for docs generation
#[derive(Debug, Clone, Default)]
pub struct DocsConfig {
    /// Title for the documentation
    pub title: Option<String>,
    /// Description/introduction text
    pub description: Option<String>,
    /// Whether to show advanced settings
    pub show_advanced: bool,
    /// Whether to group by category
    pub group_by_category: bool,
}

impl DocsConfig {
    pub fn new() -> Self {
        Self {
            show_advanced: true,
            group_by_category: true,
            ..Default::default()
        }
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    pub fn hide_advanced(mut self) -> Self {
        self.show_advanced = false;
        self
    }
}

/// Generate markdown documentation from a settings schema
pub fn generate_docs<T: SettingsSchema>(config: DocsConfig) -> String {
    let metadata = T::get_metadata();
    generate_docs_from_metadata(&metadata, config)
}

/// Generate docs from raw metadata (useful when schema isn't available)
pub fn generate_docs_from_metadata(
    metadata: &HashMap<String, SettingMetadata>,
    config: DocsConfig,
) -> String {
    let mut output = String::new();

    // Title
    let title = config
        .title
        .unwrap_or_else(|| "Settings Reference".to_string());
    output.push_str(&format!("# {}\n\n", title));

    // Description
    if let Some(desc) = config.description {
        output.push_str(&format!("{}\n\n", desc));
    }

    // Filter and sort settings
    let mut settings: Vec<_> = metadata
        .iter()
        .filter(|(_, m)| config.show_advanced || !m.advanced)
        .collect();

    settings.sort_by(|(k1, m1), (k2, m2)| {
        // Sort by category, then by order, then by key
        let cat1 = m1.category.as_deref().unwrap_or("General");
        let cat2 = m2.category.as_deref().unwrap_or("General");
        let ord1 = m1.order.unwrap_or(999);
        let ord2 = m2.order.unwrap_or(999);
        (cat1, ord1, k1).cmp(&(cat2, ord2, k2))
    });

    if config.group_by_category {
        // Group by category
        let mut current_category: Option<&str> = None;

        for (key, meta) in &settings {
            let category = meta.category.as_deref().unwrap_or("General");

            // New category header
            if current_category != Some(category) {
                output.push_str(&format!("\n## {}\n\n", capitalize(category)));
                current_category = Some(category);
            }

            output.push_str(&format_setting(key, meta));
        }
    } else {
        // Flat list
        output.push_str("## Settings\n\n");
        for (key, meta) in &settings {
            output.push_str(&format_setting(key, meta));
        }
    }

    output
}

fn format_setting(key: &str, meta: &SettingMetadata) -> String {
    let mut out = String::new();

    // Setting name with badges
    out.push_str(&format!("### `{}`\n\n", key));

    // Badges
    let mut badges = Vec::new();
    if meta.advanced {
        badges.push("🔧 Advanced");
    }
    if meta.requires_restart {
        badges.push("🔄 Requires Restart");
    }
    if meta.secret {
        badges.push("🔒 Secret");
    }
    if meta.disabled {
        badges.push("⚠️ Disabled");
    }
    if !badges.is_empty() {
        out.push_str(&format!("{}\n\n", badges.join(" • ")));
    }

    // Description
    if let Some(ref desc) = meta.description {
        out.push_str(&format!("{}\n\n", desc));
    }

    // Type and default
    out.push_str("| Property | Value |\n");
    out.push_str("|----------|-------|\n");
    out.push_str(&format!(
        "| **Type** | {} |\n",
        format_type(&meta.setting_type)
    ));
    out.push_str(&format!(
        "| **Default** | `{}` |\n",
        format_value(&meta.default)
    ));

    // Range for numbers
    if meta.setting_type == SettingType::Number {
        if let (Some(min), Some(max)) = (meta.min, meta.max) {
            out.push_str(&format!("| **Range** | {} - {} |\n", min, max));
        }
        if let Some(step) = meta.step {
            out.push_str(&format!("| **Step** | {} |\n", step));
        }
    }

    // Pattern for text
    if let Some(ref pattern) = meta.pattern {
        out.push_str(&format!("| **Pattern** | `{}` |\n", pattern));
    }

    out.push('\n');

    // Options for select
    if let Some(ref options) = meta.options {
        out.push_str("**Options:**\n\n");
        for opt in options {
            if let Some(ref desc) = opt.description {
                out.push_str(&format!(
                    "- `{}` - {} ({})\n",
                    format_value(&opt.value),
                    opt.label,
                    desc
                ));
            } else {
                out.push_str(&format!(
                    "- `{}` - {}\n",
                    format_value(&opt.value),
                    opt.label
                ));
            }
        }
        out.push('\n');
    }

    out.push_str("---\n\n");
    out
}

fn format_type(t: &SettingType) -> &'static str {
    match t {
        SettingType::Toggle => "Boolean",
        SettingType::Text => "String",
        SettingType::Number => "Number",
        SettingType::Select => "Select",
        SettingType::Color => "Color",
        SettingType::Path => "Path",
        SettingType::Textarea => "Multi-line Text",
        SettingType::Password => "Password",
        SettingType::Info => "Info (Read-only)",
    }
}

fn format_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => format!("\"{}\"", s),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => "null".to_string(),
        _ => v.to_string(),
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().chain(chars).collect(),
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{SettingOption, SettingsSchema};
    use serde::{Deserialize, Serialize};

    #[derive(Default, Serialize, Deserialize)]
    struct TestSettings {}

    impl SettingsSchema for TestSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut m = HashMap::new();
            m.insert(
                "appearance.theme".into(),
                SettingMetadata::select(
                    "Theme",
                    "system",
                    vec![
                        SettingOption::new("light", "Light"),
                        SettingOption::new("dark", "Dark"),
                        SettingOption::new("system", "System Default"),
                    ],
                )
                .category("appearance")
                .description("Choose your preferred color theme")
                .order(1),
            );
            m.insert(
                "network.port".into(),
                SettingMetadata::number("Port", 8080.0)
                    .category("network")
                    .min(1.0)
                    .max(65535.0)
                    .description("Server port number"),
            );
            m.insert(
                "security.api_key".into(),
                SettingMetadata::text("API Key", "")
                    .category("security")
                    .secret()
                    .advanced(),
            );
            m
        }
    }

    #[test]
    fn test_generate_docs() {
        let docs = generate_docs::<TestSettings>(
            DocsConfig::new()
                .with_title("My App Settings")
                .with_description("Configuration options for My App"),
        );

        assert!(docs.contains("# My App Settings"));
        assert!(docs.contains("## Appearance"));
        assert!(docs.contains("## Network"));
        assert!(docs.contains("## Security"));
        assert!(docs.contains("`appearance.theme`"));
        assert!(docs.contains("🔒 Secret"));
        assert!(docs.contains("🔧 Advanced"));
    }

    #[test]
    fn test_hide_advanced() {
        let docs = generate_docs::<TestSettings>(DocsConfig::new().hide_advanced());

        // Should not contain the advanced setting
        assert!(!docs.contains("security.api_key"));
        // Should contain non-advanced settings
        assert!(docs.contains("appearance.theme"));
    }
}
