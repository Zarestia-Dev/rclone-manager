// List settings example for rcman
//
// This example demonstrates how to work with List type settings,
// which allow storing multiple string values (Vec<String>).
//
// Run with: cargo run --example list_settings

use rcman::{SettingMetadata, SettingType, SettingsManager, SettingsSchema, settings};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings;

impl SettingsSchema for AppSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            // List of allowed email domains
            "security.allowed_domains" => SettingMetadata::list(
                &["example.com".to_string(), "mycompany.com".to_string()]
            )
            .meta_str("label", "Allowed Domains")
            .meta_str("description", "Email domains allowed to register")
            .meta_str("category", "Security"),

            // List of blocked IPs
            "security.blocked_ips" => SettingMetadata::list(&[])
                .meta_str("label", "Blocked IPs")
                .meta_str("description", "IP addresses that are blocked from accessing the service")
                .meta_str("category", "Security"),

            // List of enabled features (feature flags)
            "features.enabled" => SettingMetadata::list(
                &["notifications".to_string(), "analytics".to_string()]
            )
            .meta_str("label", "Enabled Features")
            .meta_str("description", "List of enabled feature flags")
            .meta_str("category", "Features")
            .meta_bool("advanced", true),

            // List of API endpoints
            "network.endpoints" => SettingMetadata::list(&[
                "https://api.example.com/v1".to_string(),
                "https://api.example.com/v2".to_string(),
            ])
            .meta_str("label", "API Endpoints")
            .meta_str("description", "Available API endpoints")
            .meta_str("category", "Network"),

            // List of tags or labels
            "app.tags" => SettingMetadata::list(&["production".to_string()])
                .meta_str("label", "Application Tags")
                .meta_str("description", "Tags for categorizing this application instance")
                .meta_str("category", "General"),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("📋 rcman List Settings Example\n");

    // Initialize settings manager
    let manager = SettingsManager::builder("list-example", "1.0.0")
        .with_schema::<AppSettings>()
        .with_config_dir("./example_config")
        .build()?;

    // Load settings
    let settings = manager.metadata()?;
    println!("✅ Loaded {} settings\n", settings.len());

    // =========================================================================
    // Example 1: Saving list values
    // =========================================================================
    println!("📖 Example 1: Saving list values");

    let allowed_domains = vec![
        "example.com".to_string(),
        "mycompany.com".to_string(),
        "newcorp.com".to_string(),
    ];

    manager.save_setting("security", "allowed_domains", &json!(allowed_domains))?;
    println!("Saved allowed domains: {allowed_domains:?}\n");

    // =========================================================================
    // Example 2: Working with empty lists
    // =========================================================================
    println!("🗑️  Example 2: Working with empty lists");
    let blocked_ips: Vec<String> = vec![];
    println!("Blocked IPs (initially empty): {blocked_ips:?}");

    // Add some blocked IPs
    let new_blocked = vec!["192.168.1.100".to_string(), "10.0.0.50".to_string()];
    manager.save_setting("security", "blocked_ips", &json!(new_blocked))?;
    println!("After adding blocked IPs: {new_blocked:?}\n");

    // =========================================================================
    // Example 3: Managing feature flags (list of strings)
    // =========================================================================
    println!("🚩 Example 3: Feature flags");
    let mut features = vec!["notifications".to_string(), "analytics".to_string()];
    println!("Current features: {features:?}");

    // Toggle a feature (add it)
    let feature_to_add = "dark_mode";
    if !features.contains(&feature_to_add.to_string()) {
        features.push(feature_to_add.to_string());
        println!("Enabled feature: {feature_to_add}");
    }

    manager.save_setting("features", "enabled", &json!(features))?;
    println!("Updated features: {features:?}\n");

    // =========================================================================
    // Example 4: Checking if list contains an item
    // =========================================================================
    println!("🔍 Example 4: Checking membership");
    let endpoints = vec![
        "https://api.example.com/v1".to_string(),
        "https://api.example.com/v2".to_string(),
    ];

    let check_endpoint = "https://api.example.com/v1";
    if endpoints.contains(&check_endpoint.to_string()) {
        println!("✅ Endpoint '{check_endpoint}' is configured");
    } else {
        println!("❌ Endpoint '{check_endpoint}' is NOT configured");
    }

    manager.save_setting("network", "endpoints", &json!(endpoints))?;

    // =========================================================================
    // Example 5: Sorting and deduplicating lists
    // =========================================================================
    println!("\n🔀 Example 5: Sorting and deduplicating");
    let mut tags = vec![
        "production".to_string(),
        "staging".to_string(),
        "production".to_string(), // duplicate
        "test".to_string(),
        "staging".to_string(), // duplicate
    ];
    println!("Tags before: {tags:?}");

    // Sort and deduplicate
    tags.sort();
    tags.dedup();

    manager.save_setting("app", "tags", &json!(tags))?;
    println!("After sort + dedup: {tags:?}\n");

    // =========================================================================
    // Example 6: Resetting list to default
    // =========================================================================
    println!("🔄 Example 6: Resetting to default");
    println!("Resetting allowed_domains to default...");
    let default_value = manager.reset_setting("security", "allowed_domains")?;
    println!("Default value: {default_value:?}\n");

    // =========================================================================
    // Example 7: View all list settings with metadata
    // =========================================================================
    println!("📊 Example 7: View all list settings");
    let all_settings = manager.metadata()?;
    for (key, meta) in all_settings {
        if meta.setting_type == SettingType::List {
            println!("  {} = {:?}", key, meta.value.unwrap_or(meta.default));
        }
    }

    println!(
        "💾 Config location: {}",
        manager.config().settings_path().display()
    );

    Ok(())
}
