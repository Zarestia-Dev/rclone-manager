//! Profiles Usage Example
//!
//! Demonstrates how to use profiles with sub-settings to maintain
//! multiple named configurations.
//!
//! Run with: cargo run --example `profiles_usage` --features profiles

use rcman::{SettingsManager, SubSettingsConfig};
use serde::{Deserialize, Serialize};
use tempfile::tempdir;

#[derive(Debug, Serialize, Deserialize)]
struct RemoteConfig {
    #[serde(rename = "type")]
    remote_type: String,
    endpoint: Option<String>,
}

fn main() -> rcman::Result<()> {
    // Create a temporary directory for this example
    let temp_dir = tempdir().expect("Failed to create temp dir");
    println!("📁 Config directory: {}", temp_dir.path().display());

    // Create a settings manager with profiled remotes
    let manager = SettingsManager::builder("my-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()?;

    // Get the remotes sub-settings
    let remotes = manager.sub_settings("remotes")?;

    // Access the profile manager
    let profiles = remotes.profiles()?;

    println!("\n🎭 Profile Management Demo\n");

    // --- Profile Operations ---

    // List initial profiles (just "default")
    println!("📋 Initial profiles: {:?}", profiles.list()?);
    println!("✅ Active profile: {}", profiles.active()?);

    // Create some data in the default profile
    remotes.set(
        "personal-gdrive",
        &RemoteConfig {
            remote_type: "drive".into(),
            endpoint: None,
        },
    )?;
    println!("\n💾 Added 'personal-gdrive' to default profile");

    // Create a "work" profile
    profiles.create("work")?;
    println!("✨ Created 'work' profile");

    // Create a "travel" profile
    profiles.create("travel")?;
    println!("✨ Created 'travel' profile");

    // List all profiles
    println!("📋 All profiles: {:?}", profiles.list()?);

    // --- Switching Profiles ---

    println!("\n🔄 Switching to 'work' profile...");
    remotes.switch_profile("work")?; // Seamless switch!
    println!("✅ Active profile: {}", profiles.active()?);

    // The 'work' profile is empty - let's add some remotes
    remotes.set(
        "company-sharepoint",
        &RemoteConfig {
            remote_type: "sharepoint".into(),
            endpoint: Some("https://company.sharepoint.com".into()),
        },
    )?;
    remotes.set(
        "dev-s3",
        &RemoteConfig {
            remote_type: "s3".into(),
            endpoint: Some("https://s3.amazonaws.com".into()),
        },
    )?;
    println!("💾 Added work remotes: {:?}", remotes.list()?);

    // --- Duplicate Profile ---

    println!("\n📋 Duplicating 'work' to 'work-backup'...");
    profiles.duplicate("work", "work-backup")?;
    println!("📋 All profiles: {:?}", profiles.list()?);

    // --- Rename Profile ---

    println!("\n📝 Renaming 'travel' to 'vacation'...");
    profiles.rename("travel", "vacation")?;
    println!("📋 All profiles: {:?}", profiles.list()?);

    // --- Delete Profile ---

    println!("\n🗑️ Deleting 'vacation' profile...");
    profiles.delete("vacation")?;
    println!("📋 Remaining profiles: {:?}", profiles.list()?);

    // --- Switch Back and Verify ---

    println!("\n🔄 Switching back to 'default' profile...");
    remotes.switch_profile("default")?; // Seamless switch!
    println!("📋 Remotes in default profile: {:?}", remotes.list()?);

    // --- Event Handling ---

    println!("\n📢 Setting up event listener...");
    profiles.set_on_event(|event| {
        println!("  🔔 Profile event: {event:?}");
    });

    profiles.create("demo")?;
    remotes.switch_profile("demo")?;
    profiles.rename("demo", "demo2")?;
    remotes.switch_profile("default")?;
    profiles.delete("demo2")?;

    println!("\n✅ Demo complete!");
    println!("\n📂 Directory structure:");
    print_tree(temp_dir.path(), 0);

    Ok(())
}

fn print_tree(path: &std::path::Path, depth: usize) {
    let indent = "  ".repeat(depth);
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if entry.path().is_dir() {
                println!("{indent}{name_str}/");
                print_tree(&entry.path(), depth + 1);
            } else {
                println!("{indent}{name_str}");
            }
        }
    }
}
