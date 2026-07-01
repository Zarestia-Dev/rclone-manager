// Validation example for rcman
//
// Run with: cargo run --example with_validation

use rcman::{SettingMetadata, SettingsManager, SettingsSchema, settings};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings;

impl SettingsSchema for AppSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "user.email" => SettingMetadata::text("user@example.com")
                .meta_str("label", "Email")
                .meta_str("description", "User email address")
                .meta_str("placeholder", "user@example.com")
                .pattern(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"),

            "user.username" => SettingMetadata::text("")
                .meta_str("label", "Username")
                .meta_str("description", "Username (3-20 alphanumeric characters)")
                .pattern(r"^[a-zA-Z0-9_]{3,20}$"),

            "network.port" => SettingMetadata::number(3000.0)
                .meta_str("label", "Port")
                .meta_str("description", "Server port (1024-65535)")
                .min(1024.0)
                .max(65535.0),

            "network.max_connections" => SettingMetadata::number(100.0)
                .meta_str("label", "Max Connections")
                .meta_str("description", "Maximum concurrent connections")
                .min(1.0)
                .max(10000.0)
                .step(10.0),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manager = SettingsManager::builder("validation-example", "1.0.0")
        .with_schema::<AppSettings>()
        .with_config_dir("./example_config")
        .build()?;

    println!("🔍 rcman Validation Example\n");

    // Load initial settings
    manager.metadata()?;

    // Test valid email
    println!("✅ Testing valid email...");
    match manager.save_setting("user", "email", &json!("john@example.com")) {
        Ok(()) => println!("   Success: Email saved\n"),
        Err(e) => println!("   Error: {e}\n"),
    }

    // Test invalid email
    println!("❌ Testing invalid email...");
    match manager.save_setting("user", "email", &json!("not-an-email")) {
        Ok(()) => println!("   Unexpected success\n"),
        Err(e) => println!("   Expected error: {e}\n"),
    }

    // Test valid username
    println!("✅ Testing valid username...");
    match manager.save_setting("user", "username", &json!("john_doe")) {
        Ok(()) => println!("   Success: Username saved\n"),
        Err(e) => println!("   Error: {e}\n"),
    }

    // Test invalid username (too short)
    println!("❌ Testing invalid username (too short)...");
    match manager.save_setting("user", "username", &json!("ab")) {
        Ok(()) => println!("   Unexpected success\n"),
        Err(e) => println!("   Expected error: {e}\n"),
    }

    // Test port range validation
    println!("✅ Testing valid port...");
    match manager.save_setting("network", "port", &json!(8080)) {
        Ok(()) => println!("   Success: Port saved\n"),
        Err(e) => println!("   Error: {e}\n"),
    }

    // Test port out of range
    println!("❌ Testing port out of range...");
    match manager.save_setting("network", "port", &json!(80)) {
        Ok(()) => println!("   Unexpected success\n"),
        Err(e) => println!("   Expected error: {e}\n"),
    }

    println!("✨ Validation example complete!");

    Ok(())
}
