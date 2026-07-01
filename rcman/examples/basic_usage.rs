// Basic usage example for rcman
//
// Run with: cargo run --example basic_usage

use rcman::{SettingMetadata, SettingsManager, SettingsSchema, opt, settings};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

// Define your settings schema
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings;

impl SettingsSchema for AppSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "app.name" => SettingMetadata::text("My App")
                .meta_str("label", "Application Name")
                .meta_str("description", "The name of your application")
                .meta_str("category", "General"),

            "app.theme" => SettingMetadata::select("light", vec![
                opt("light", "Light"),
                opt("dark", "Dark"),
                opt("auto", "Auto"),
            ])
            .meta_str("label", "Theme")
            .meta_str("description", "UI theme preference")
            .meta_str("category", "Appearance"),

            "network.port" => SettingMetadata::number(8080.0)
                .meta_str("label", "Port")
                .meta_str("description", "Server port")
                .min(1024.0)
                .max(65535.0)
                .meta_str("category", "Network"),

            "network.allowed_origins" => SettingMetadata::list(&[
                "http://localhost:3000".to_string(),
            ])
            .meta_str("label", "Allowed Origins")
            .meta_str("description", "CORS allowed origins")
            .meta_str("category", "Network"),

            "advanced.debug" => SettingMetadata::toggle(false)
                .meta_str("label", "Debug Mode")
                .meta_str("description", "Enable debug logging")
                .meta_str("category", "Advanced")
                .meta_bool("advanced", true),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize settings manager with fluent builder API
    let manager = SettingsManager::builder("my-app", "1.0.0")
        .with_schema::<AppSettings>()
        .with_config_dir("./example_config")
        .build()?;

    println!("📦 rcman Basic Usage Example\n");

    // Load settings (creates file with defaults if it doesn't exist)
    let settings = manager.metadata()?;
    println!("✅ Loaded settings:");
    println!("{}\n", serde_json::to_string_pretty(&settings)?);

    // Update a setting
    println!("🔧 Changing theme to 'dark'...");
    manager.save_setting("app", "theme", &json!("dark"))?;

    // Load again to see the change
    let updated = manager.metadata()?;
    println!("✅ Updated settings:");
    println!("{}\n", serde_json::to_string_pretty(&updated)?);

    // Reset a setting to default
    println!("🔄 Resetting theme to default...");
    let default_theme = manager.reset_setting("app", "theme")?;
    println!("✅ Theme reset to: {default_theme}\n");

    // Working with list settings
    println!("📋 Working with List Settings:");

    // Load settings with metadata to see current values
    let settings_meta = manager.metadata()?;
    if let Some(meta) = settings_meta.get("network.allowed_origins")
        && let Some(value) = &meta.value
    {
        println!("Current allowed origins: {value}");
    }

    println!("\n🔧 Adding new origin...");
    manager.save_setting(
        "network",
        "allowed_origins",
        &json!(["http://localhost:3000", "https://example.com"]),
    )?;

    // Load settings with metadata to see the change
    let updated = manager.metadata()?;
    if let Some(meta) = updated.get("network.allowed_origins")
        && let Some(value) = &meta.value
    {
        println!("✅ Updated allowed origins: {value}\n");
    }

    println!(
        "💾 Settings file location: {:?}",
        manager.config().settings_path().display()
    );

    Ok(())
}
