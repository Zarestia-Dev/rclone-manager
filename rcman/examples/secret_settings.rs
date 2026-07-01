// Secret settings example for rcman
//
// Run with: cargo run --example secret_settings --features keychain

#[cfg(feature = "keychain")]
use rcman::{SettingMetadata, SettingsManager, SettingsSchema, settings};
#[cfg(feature = "keychain")]
use serde::{Deserialize, Serialize};
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
            "app.name" => SettingMetadata::text("My App")
                .meta_str("label", "App Name"),

            "secrets.api_key" => SettingMetadata::text("")
                .meta_str("label", "API Key")
                .meta_str("description", "Your API key")
                .meta_str("input_type", "password")
                .secret(),

            "secrets.api_token" => SettingMetadata::text("")
                .meta_str("label", "API Token")
                .meta_str("description", "Authentication token")
                .meta_str("input_type", "password")
                .secret(),

            "secrets.db_password" => SettingMetadata::text("")
                .meta_str("label", "DB Password")
                .meta_str("description", "Database password")
                .meta_str("input_type", "password")
                .secret(),
        }
    }
}

#[cfg(feature = "keychain")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manager = SettingsManager::builder("secret-example", "1.0.0")
        .with_config_dir("./example_config")
        .with_schema::<AppSettings>()
        .with_credentials() // Enable credential management
        .build()?;

    println!("🔐 rcman Secret Settings Example\n");
    println!("This example requires the 'keychain' feature.");
    println!("Secrets are stored in your OS keychain, not in the settings file.\n");

    // Load settings
    manager.metadata()?;

    // Save a secret (stored in keychain)
    println!("💾 Saving API key to keychain...");
    manager.save_setting("secrets", "api_key", &json!("sk_test_1234567890"))?;
    println!("✅ API key saved securely\n");

    // Save another secret
    println!("💾 Saving database password to keychain...");
    manager.save_setting("secrets", "db_password", &json!("super_secret_password"))?;
    println!("✅ Database password saved securely\n");

    // Load settings again - secrets will be retrieved from keychain
    println!("📖 Loading settings (including secrets from keychain)...");
    let settings = manager.metadata()?;

    // Note: In the JSON output, secrets will show their values
    // But they are NOT stored in the settings.json file
    println!("✅ Settings loaded:");
    println!("{}\n", serde_json::to_string_pretty(&settings)?);

    println!("📁 Check your settings file - secrets are NOT there!");
    println!("   File: {}\n", manager.config().settings_path().display());

    println!("🔑 Secrets are stored in your OS keychain:");
    #[cfg(target_os = "macos")]
    println!("   macOS: Keychain Access app");
    #[cfg(target_os = "ios")]
    println!("   iOS: Keychain");
    #[cfg(target_os = "linux")]
    println!("   Linux: GNOME Keyring / KWallet");
    #[cfg(target_os = "android")]
    println!("   Android: EncryptedSharedPreferences (or Keystore on older versions)");
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
