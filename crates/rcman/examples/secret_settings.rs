// Secret settings example for rcman
//
// Run with: cargo run --example secret_settings --features keychain

#[cfg(feature = "keychain")]
use rcman::{SettingsManager, SettingsConfig, SettingsSchema, SettingMetadata, settings};
#[cfg(feature = "keychain")]
use serde::{Serialize, Deserialize};
#[cfg(feature = "keychain")]
use serde_json::json;
#[cfg(feature = "keychain")]
use std::collections::HashMap;

#[cfg(feature = "keychain")]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings;

#[cfg(feature = "keychain")]
impl SettingsSchema for AppSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "app.name" => SettingMetadata::text("App Name", "My App"),
            
            "secrets.api_key" => SettingMetadata::password("API Key", "")
                .description("Your API key")
                .secret(),
            
            "secrets.api_token" => SettingMetadata::password("API Token", "")
                .description("Authentication token")
                .secret(),
            
            "secrets.db_password" => SettingMetadata::password("DB Password", "")
                .description("Database password")
                .secret(),
        }
    }
}

#[cfg(feature = "keychain")]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = SettingsConfig::builder("secret-example", "1.0.0")
        .config_dir("./example_config")
        .with_credentials()  // Enable credential management
        .build();
    
    let manager = SettingsManager::new(config)?;
    
    println!("🔐 rcman Secret Settings Example\n");
    println!("This example requires the 'keychain' feature.");
    println!("Secrets are stored in your OS keychain, not in the settings file.\n");
    
    // Load settings
    manager.load_settings::<AppSettings>()?;
    
    // Save a secret (stored in keychain)
    println!("💾 Saving API key to keychain...");
    manager.save_setting::<AppSettings>("secrets", "api_key", json!("sk_test_1234567890"))?;
    println!("✅ API key saved securely\n");
    
    // Save another secret
    println!("💾 Saving database password to keychain...");
    manager.save_setting::<AppSettings>("secrets", "db_password", json!("super_secret_password"))?;
    println!("✅ Database password saved securely\n");
    
    // Load settings again - secrets will be retrieved from keychain
    println!("📖 Loading settings (including secrets from keychain)...");
    let settings = manager.load_settings::<AppSettings>()?;
    
    // Note: In the JSON output, secrets will show their values
    // But they are NOT stored in the settings.json file
    println!("✅ Settings loaded:");
    println!("{}\n", serde_json::to_string_pretty(&settings)?);
    
    println!("📁 Check your settings file - secrets are NOT there!");
    println!("   File: {:?}\n", manager.config().settings_path());
    
    println!("🔑 Secrets are stored in your OS keychain:");
    #[cfg(target_os = "macos")]
    println!("   macOS: Keychain Access app");
    #[cfg(target_os = "linux")]
    println!("   Linux: GNOME Keyring / KWallet");
    #[cfg(target_os = "windows")]
    println!("   Windows: Credential Manager");
    
    Ok(())
}

#[cfg(not(feature = "keychain"))]
fn main() {
    eprintln!("❌ This example requires the 'keychain' feature.");
    eprintln!("Run with: cargo run --example secret_settings --features keychain");
    std::process::exit(1);
}
