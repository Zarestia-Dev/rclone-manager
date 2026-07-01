use rcman::{JsonStorage, SettingMetadata, SettingsManagerBuilder, SettingsSchema};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Barrier};
use std::thread;
use tempfile::tempdir;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TestSchema {
    general: HashMap<String, serde_json::Value>,
}

impl SettingsSchema for TestSchema {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        let mut map = HashMap::new();
        // Define a test setting
        map.insert(
            "general.test_key".to_string(),
            SettingMetadata::text("default"),
        );
        map
    }
}

#[test]
fn test_concurrent_access() {
    let dir = tempdir().unwrap();
    // Explicitly specify defaults for new() to avoid ambiguity
    let manager = SettingsManagerBuilder::<JsonStorage, ()>::new("test-app", "1.0.0")
        .with_config_dir(dir.path().to_path_buf())
        .with_schema::<TestSchema>()
        .build()
        .unwrap();

    let manager = Arc::new(manager);
    let barrier = Arc::new(Barrier::new(10));
    let mut handles = vec![];

    for i in 0..10 {
        let m = Arc::clone(&manager);
        let b = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            b.wait();
            // Perform mixed reads and writes
            if i % 2 == 0 {
                let _ = m.get_all();
            } else {
                let _ = m.save_setting("general", "test_key", &json!(i));
            }
        }));
    }

    for handle in handles {
        handle.join().unwrap();
    }
}

#[cfg(feature = "profiles")]
#[test]
fn test_concurrent_profile_switching() {
    let dir = tempdir().unwrap();
    // Explicitly specify defaults for new() to avoid ambiguity
    let manager = SettingsManagerBuilder::<JsonStorage, ()>::new("test-app", "1.0.0")
        .with_config_dir(dir.path().to_path_buf())
        .with_schema::<TestSchema>()
        .with_profiles() // Enable profiles!
        .build()
        .unwrap();

    // Create a profile first
    if let Some(pm) = manager.profiles() {
        pm.create("test-profile").unwrap();
    } else {
        panic!("Profiles feature enabled but manager.profiles() returned None");
    }

    let manager = Arc::new(manager);
    let barrier = Arc::new(Barrier::new(5));
    let mut handles = vec![];

    for _ in 0..5 {
        let m = Arc::clone(&manager);
        let b = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            b.wait();
            // Contend on profile switching
            if let Some(pm) = m.profiles() {
                // Ignore errors (some contentions might cause transient failures but valid code path)
                let _ = pm.switch("test-profile");
                let _ = pm.switch("default");
            }
        }));
    }

    for handle in handles {
        handle.join().unwrap();
    }
}
