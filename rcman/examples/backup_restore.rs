// Backup and restore example for rcman
//
// Run with: cargo run --example backup_restore

#[cfg(feature = "backup")]
use rcman::{
    BackupOptions, RestoreOptions, SettingMetadata, SettingsManager, SettingsSchema, settings,
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
            "app.name" => SettingMetadata::text("My App")
                .meta_str("label", "App Name"),
            "app.version" => SettingMetadata::text("1.0.0")
                .meta_str("label", "Version"),
            "app.theme" => SettingMetadata::select("light", vec![
                rcman::opt("light", "Light"),
                rcman::opt("dark", "Dark"),
            ])
            .meta_str("label", "Theme"),
            "user.name" => SettingMetadata::text("John Doe")
                .meta_str("label", "User Name"),
            "user.email" => SettingMetadata::text("user@example.com")
                .meta_str("label", "Email"),
        }
    }
}

#[cfg(feature = "backup")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manager = SettingsManager::builder("backup-example", "1.0.0")
        .with_schema::<AppSettings>()
        .with_config_dir("./example_config")
        .build()?;

    println!("💾 rcman Backup & Restore Example\n");

    // Create some settings
    println!("📝 Creating initial settings...");
    manager.metadata()?;
    manager.save_setting("app", "theme", &json!("dark"))?;
    manager.save_setting("user", "name", &json!("Alice"))?;
    manager.save_setting("user", "email", &json!("alice@example.com"))?;

    let settings = manager.metadata()?;
    println!("✅ Initial settings:");
    println!("{}\n", serde_json::to_string_pretty(&settings)?);

    // Create a backup using the builder pattern
    println!("📦 Creating backup...");
    let backup_path = manager.backup().create(
        &BackupOptions::new()
            .output_dir("./example_config/backups")
            .note("Example backup"),
    )?;
    println!("✅ Backup created: {}", backup_path.display());

    // Modify settings
    println!("🔧 Modifying settings...");
    manager.save_setting("app", "theme", &json!("light"))?;
    manager.save_setting("user", "name", &json!("Bob"))?;

    let modified = manager.metadata()?;
    println!("✅ Modified settings:");
    println!("{}\n", serde_json::to_string_pretty(&modified)?);

    // Restore from backup using the builder pattern
    println!("♻️  Restoring from backup...");
    manager.backup().restore(
        &RestoreOptions::from_path(&backup_path)
            .overwrite(true)
            .verify_checksum(true),
    )?;
    println!("✅ Restored from backup\n");

    // Verify restoration
    let restored = manager.metadata()?;
    println!("✅ Restored settings:");
    println!("{}\n", serde_json::to_string_pretty(&restored)?);

    println!("✨ Backup/restore example complete!");
    println!("📁 Backup saved to: {}", backup_path.display());

    Ok(())
}

#[cfg(not(feature = "backup"))]
fn main() {
    eprintln!("❌ This example requires the 'backup' feature (enabled by default).");
    eprintln!("Run with: cargo run --example backup_restore");
    std::process::exit(1);
}
