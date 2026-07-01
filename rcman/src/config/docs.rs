//! Documentation generator for settings schema
//!
//! Generates markdown documentation from `SettingsSchema` metadata.

use crate::config::{SettingMetadata, SettingType, SettingsSchema};
use std::collections::HashMap;

/// Configuration for docs generation
#[derive(Debug, Clone)]
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

impl Default for DocsConfig {
    fn default() -> Self {
        Self {
            title: None,
            description: None,
            show_advanced: true,
            group_by_category: true,
        }
    }
}

impl DocsConfig {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    #[must_use]
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    #[must_use]
    pub fn hide_advanced(mut self) -> Self {
        self.show_advanced = false;
        self
    }
}

/// Generate markdown documentation from a settings schema
#[must_use]
pub fn generate_docs<T: SettingsSchema>(config: DocsConfig) -> String {
    let metadata = T::get_metadata();
    generate_docs_from_metadata(&metadata, config)
}

/// Generate docs from raw metadata (useful when schema isn't available)
#[must_use]
pub fn generate_docs_from_metadata<S: std::hash::BuildHasher>(
    metadata: &HashMap<String, SettingMetadata, S>,
    config: DocsConfig,
) -> String {
    use std::fmt::Write;

    let mut output = String::new();

    // Title
    let title = config
        .title
        .unwrap_or_else(|| "Settings Reference".to_string());
    let _ = writeln!(output, "# {title}\n");

    // Description
    if let Some(desc) = config.description {
        let _ = writeln!(output, "{desc}\n");
    }

    // Filter and sort settings
    let mut settings: Vec<_> = metadata
        .iter()
        .filter(|(_, m)| config.show_advanced || !m.get_meta_bool("advanced").unwrap_or(false))
        .collect();

    settings.sort_by(|(k1, m1), (k2, m2)| {
        // Sort by category, then by order, then by key
        let cat1 = m1.get_meta_str("category").unwrap_or("General");
        let cat2 = m2.get_meta_str("category").unwrap_or("General");

        // Compare category first
        match cat1.cmp(cat2) {
            std::cmp::Ordering::Equal => {
                // Then compare by order (as f64)
                let ord1 = m1.get_meta_num("order").unwrap_or(999.0);
                let ord2 = m2.get_meta_num("order").unwrap_or(999.0);
                match ord1.partial_cmp(&ord2).unwrap_or(std::cmp::Ordering::Equal) {
                    std::cmp::Ordering::Equal => k1.cmp(k2),
                    other => other,
                }
            }
            other => other,
        }
    });

    if config.group_by_category {
        // Group by category
        let mut current_category: Option<&str> = None;

        for (key, meta) in &settings {
            let category = meta.get_meta_str("category").unwrap_or("General");

            // New category header
            if current_category != Some(category) {
                let _ = writeln!(output, "\n## {}\n", capitalize(category));
                current_category = Some(category);
            }

            format_setting(&mut output, key, meta);
        }
    } else {
        // Flat list
        output.push_str("## Settings\n\n");
        for (key, meta) in &settings {
            format_setting(&mut output, key, meta);
        }
    }

    output
}

fn format_setting(out: &mut String, key: &str, meta: &SettingMetadata) {
    use std::fmt::Write;

    // Setting name with badges
    let _ = writeln!(out, "### `{key}`\n");

    // Badges (from dynamic metadata)
    let mut badges = Vec::new();
    if meta.get_meta_bool("advanced").unwrap_or(false) {
        badges.push("Advanced");
    }
    if meta.get_meta_bool("requires_restart").unwrap_or(false) {
        badges.push("Requires Restart");
    }
    if meta.get_meta_bool("secret").unwrap_or(false) {
        badges.push("Secret");
    }
    if meta.get_meta_bool("disabled").unwrap_or(false) {
        badges.push("Disabled");
    }
    if !badges.is_empty() {
        let _ = writeln!(out, "{}\n", badges.join(" • "));
    }

    // Description (from dynamic metadata)
    if let Some(desc) = meta.get_meta_str("description") {
        let _ = writeln!(out, "{desc}\n");
    }

    // Type and default
    out.push_str("| Property | Value |\n");
    out.push_str("|----------|-------|\n");
    let _ = writeln!(out, "| **Type** | {} |", format_type(&meta.setting_type));
    let _ = writeln!(out, "| **Default** | `{}` |", format_value(&meta.default));

    // Range for numbers
    if meta.setting_type == SettingType::Number {
        if let (Some(min), Some(max)) = (meta.constraints.number.min, meta.constraints.number.max) {
            let _ = writeln!(out, "| **Range** | {min} - {max} |");
        }
        if let Some(step) = meta.constraints.number.step {
            let _ = writeln!(out, "| **Step** | {step} |");
        }
    }

    // Pattern for text
    if let Some(ref pattern) = meta.constraints.text.pattern {
        let _ = writeln!(out, "| **Pattern** | `{pattern}` |");
    }

    out.push('\n');

    // Options for select
    if let Some(ref options) = meta.constraints.options {
        out.push_str("**Options:**\n\n");
        for opt in options {
            if let Some(ref desc) = opt.description {
                let _ = writeln!(
                    out,
                    "- `{}` - {} ({})",
                    format_value(&opt.value),
                    opt.label,
                    desc
                );
            } else {
                let _ = writeln!(out, "- `{}` - {}", format_value(&opt.value), opt.label);
            }
        }
        out.push('\n');
    }

    out.push_str("---\n\n");
}

fn format_type(t: &SettingType) -> &'static str {
    match t {
        SettingType::Toggle => "Boolean",
        SettingType::Text => "String",
        SettingType::Number => "Number",
        SettingType::Select => "Select",
        SettingType::Info => "Info (Read-only)",
        SettingType::List => "List (Strings)",
        SettingType::Object => "Object (JSON)",
    }
}

fn format_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => format!("\"{s}\""),
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
                    "system",
                    vec![
                        SettingOption::new("light", "Light"),
                        SettingOption::new("dark", "Dark"),
                        SettingOption::new("system", "System Default"),
                    ],
                )
                .meta_str("label", "Theme")
                .meta_str("category", "appearance")
                .meta_str("description", "Choose your preferred color theme")
                .meta_num("order", 1.0),
            );
            m.insert(
                "network.port".into(),
                SettingMetadata::number(8080.0)
                    .meta_str("label", "Port")
                    .meta_str("category", "network")
                    .min(1.0)
                    .max(65535.0)
                    .meta_str("description", "Server port number"),
            );
            m.insert("security.api_key".into(), {
                let s = SettingMetadata::text("")
                    .meta_str("label", "API Key")
                    .meta_str("category", "security")
                    .meta_bool("advanced", true);
                #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
                let s = s.secret();
                s
            });
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
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        assert!(docs.contains("Secret"));
        assert!(docs.contains("Advanced"));
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
