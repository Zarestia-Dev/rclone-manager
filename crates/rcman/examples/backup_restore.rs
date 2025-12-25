// Backup and restore example for rcman
//
// Run with: cargo run --example backup_restore

#[cfg(feature = "backup")]
use rcman::{
    settings, BackupOptions, RestoreOptions, SettingMetadata, SettingsConfig, SettingsManager,
    SettingsSchema,
};
#[cfg(feature = "backup")]
use serde::{Deserialize, Serialize};
#[cfg(feature = "backup")]
use serde_json::json;
#[cfg(feature = "backup")]
use std::collections::HashMap;

#[cfg(feature = "backup")]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings;

#[cfg(feature = "backup")]
impl SettingsSchema for AppSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "app.name" => SettingMetadata::text("App Name", "My App"),
            "app.version" => SettingMetadata::text("Version", "1.0.0"),
            "app.theme" => SettingMetadata::select("Theme", "light", vec![
                rcman::opt("light", "Light"),
                rcman::opt("dark", "Dark"),
            ]),
            "user.name" => SettingMetadata::text("User Name", "John Doe"),
            "user.email" => SettingMetadata::text("Email", "user@example.com"),
        }
    }
}

#[cfg(feature = "backup")]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = SettingsConfig::builder("backup-example", "1.0.0")
        .config_dir("./example_config")
        .build();

    let manager = SettingsManager::new(config)?;

    println!("💾 rcman Backup & Restore Example\n");

    // Create some settings
    println!("📝 Creating initial settings...");
    manager.load_settings::<AppSettings>()?;
    manager.save_setting::<AppSettings>("app", "theme", json!("dark"))?;
    manager.save_setting::<AppSettings>("user", "name", json!("Alice"))?;
    manager.save_setting::<AppSettings>("user", "email", json!("alice@example.com"))?;

    let settings = manager.load_settings::<AppSettings>()?;
    println!("✅ Initial settings:");
    println!("{}\n", serde_json::to_string_pretty(&settings)?);

    // Create a backup using the builder pattern
    println!("📦 Creating backup...");
    let backup_path = manager.backup().create(
        BackupOptions::new()
            .output_dir("./example_config/backups")
            .note("Example backup"),
    )?;
    println!("✅ Backup created: {:?}\n", backup_path);

    // Modify settings
    println!("🔧 Modifying settings...");
    manager.save_setting::<AppSettings>("app", "theme", json!("light"))?;
    manager.save_setting::<AppSettings>("user", "name", json!("Bob"))?;

    let modified = manager.load_settings::<AppSettings>()?;
    println!("✅ Modified settings:");
    println!("{}\n", serde_json::to_string_pretty(&modified)?);

    // Restore from backup using the builder pattern
    println!("♻️  Restoring from backup...");
    manager.backup().restore(
        RestoreOptions::from_path(&backup_path)
            .overwrite(true)
            .verify_checksum(true),
    )?;
    println!("✅ Restored from backup\n");

    // Verify restoration
    let restored = manager.load_settings::<AppSettings>()?;
    println!("✅ Restored settings:");
    println!("{}\n", serde_json::to_string_pretty(&restored)?);

    println!("✨ Backup/restore example complete!");
    println!("📁 Backup saved to: {:?}", backup_path);

    Ok(())
}

#[cfg(not(feature = "backup"))]
fn main() {
    eprintln!("❌ This example requires the 'backup' feature (enabled by default).");
    eprintln!("Run with: cargo run --example backup_restore");
    std::process::exit(1);
}
