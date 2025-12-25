// Validation example for rcman
//
// Run with: cargo run --example with_validation

use rcman::{SettingsManager, SettingsConfig, SettingsSchema, SettingMetadata, settings};
use serde::{Serialize, Deserialize};
use serde_json::json;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings;

impl SettingsSchema for AppSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "user.email" => SettingMetadata::text("Email", "user@example.com")
                .description("User email address")
                .pattern(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
                .pattern_error("Please enter a valid email address")
                .placeholder("user@example.com"),
            
            "user.username" => SettingMetadata::text("Username", "")
                .description("Username (3-20 alphanumeric characters)")
                .pattern(r"^[a-zA-Z0-9_]{3,20}$")
                .pattern_error("Username must be 3-20 alphanumeric characters"),
            
            "network.port" => SettingMetadata::number("Port", 3000)
                .description("Server port (1024-65535)")
                .min(1024.0)
                .max(65535.0),
            
            "network.max_connections" => SettingMetadata::number("Max Connections", 100)
                .description("Maximum concurrent connections")
                .min(1.0)
                .max(10000.0)
                .step(10.0),
        }
    }
}


fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = SettingsConfig::builder("validation-example", "1.0.0")
        .config_dir("./example_config")
        .build();
    
    let manager = SettingsManager::new(config)?;
    
    println!("🔍 rcman Validation Example\n");
    
    // Load initial settings
    manager.load_settings::<AppSettings>()?;
    
    // Test valid email
    println!("✅ Testing valid email...");
    match manager.save_setting::<AppSettings>("user", "email", json!("john@example.com")) {
        Ok(_) => println!("   Success: Email saved\n"),
        Err(e) => println!("   Error: {}\n", e),
    }
    
    // Test invalid email
    println!("❌ Testing invalid email...");
    match manager.save_setting::<AppSettings>("user", "email", json!("not-an-email")) {
        Ok(_) => println!("   Unexpected success\n"),
        Err(e) => println!("   Expected error: {}\n", e),
    }
    
    // Test valid username
    println!("✅ Testing valid username...");
    match manager.save_setting::<AppSettings>("user", "username", json!("john_doe")) {
        Ok(_) => println!("   Success: Username saved\n"),
        Err(e) => println!("   Error: {}\n", e),
    }
    
    // Test invalid username (too short)
    println!("❌ Testing invalid username (too short)...");
    match manager.save_setting::<AppSettings>("user", "username", json!("ab")) {
        Ok(_) => println!("   Unexpected success\n"),
        Err(e) => println!("   Expected error: {}\n", e),
    }
    
    // Test port range validation
    println!("✅ Testing valid port...");
    match manager.save_setting::<AppSettings>("network", "port", json!(8080)) {
        Ok(_) => println!("   Success: Port saved\n"),
        Err(e) => println!("   Error: {}\n", e),
    }
    
    // Test port out of range
    println!("❌ Testing port out of range...");
    match manager.save_setting::<AppSettings>("network", "port", json!(80)) {
        Ok(_) => println!("   Unexpected success\n"),
        Err(e) => println!("   Expected error: {}\n", e),
    }
    
    println!("✨ Validation example complete!");
    
    Ok(())
}
