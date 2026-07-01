//! Performance and Stress Tests
//!
//! Tests that verify performance characteristics and stress scenarios:
//! - Large numbers of settings
//! - Rapid sequential operations
//! - Memory usage patterns
//! - File I/O efficiency
//!
//! Note: These tests are marked with #[ignore] by default.
//! Run with: cargo test --test `performance_test` -- --ignored

mod common;

use common::TestFixture;
use serde_json::json;
use std::sync::Arc;
use std::thread;
use std::time::Instant;

// =============================================================================
// High-Frequency Operations
// =============================================================================

#[test]
#[ignore = "Performance test"]
fn test_rapid_sequential_saves() {
    let fixture = TestFixture::new();
    let _ = fixture.manager.get_all().unwrap();

    let start = Instant::now();

    // Save 1000 times rapidly
    for i in 0..1000 {
        let theme = if i % 2 == 0 { "light" } else { "dark" };
        fixture
            .manager
            .save_setting("ui", "theme", &json!(theme))
            .unwrap();
    }

    let duration = start.elapsed();
    println!("1000 sequential saves took: {duration:?}");

    // Should complete in reasonable time (< 5 seconds for 1000 operations)
    assert!(duration.as_secs() < 5);
}

#[test]
#[ignore = "Performance test"]
fn test_rapid_sequential_loads() {
    let fixture = TestFixture::new();
    let _ = fixture.manager.get_all().unwrap();

    // Save once
    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();

    let start = Instant::now();

    // Load 1000 times (should be fast due to caching)
    for _ in 0..1000 {
        let _ = fixture.manager.metadata().unwrap();
    }

    let duration = start.elapsed();
    println!("1000 sequential loads took: {duration:?}");

    // Cached loads should be very fast (< 1 second for 1000 operations)
    assert!(duration.as_secs() < 1);
}

#[test]
#[ignore = "Performance test"]
fn test_mixed_read_write_workload() {
    let fixture = TestFixture::new();
    let _ = fixture.manager.get_all().unwrap();

    let start = Instant::now();

    for i in 0..500 {
        // Save
        let theme = if i % 2 == 0 { "light" } else { "dark" };
        fixture
            .manager
            .save_setting("ui", "theme", &json!(theme))
            .unwrap();

        // Load
        let _ = fixture.manager.metadata().unwrap();
    }

    let duration = start.elapsed();
    println!("500 save+load cycles took: {duration:?}");

    assert!(duration.as_secs() < 10);
}

// =============================================================================
// Large Number of Sub-Settings
// =============================================================================

#[test]
#[ignore = "Performance test"]
fn test_many_sub_settings_entities() {
    let fixture = TestFixture::with_sub_settings();

    let start = Instant::now();

    let remotes = fixture.manager.sub_settings("remotes").unwrap();

    // Create 1000 entities
    for i in 0..1000 {
        remotes
            .set(
                &format!("remote{i}"),
                &json!({
                    "type": "s3",
                    "bucket": format!("bucket-{}", i),
                    "region": "us-west-2",
                    "endpoint": format!("https://s3-{}.example.com", i)
                }),
            )
            .unwrap();
    }

    let create_duration = start.elapsed();
    println!("Creating 1000 entities took: {create_duration:?}");

    // List all entities
    let start = Instant::now();
    let all_keys = remotes.list().unwrap();
    let list_duration = start.elapsed();

    println!("Listing 1000 entities took: {list_duration:?}");
    assert_eq!(all_keys.len(), 1000);

    // Read them back
    let start = Instant::now();
    for i in 0..1000 {
        let _: serde_json::Value = remotes.get(&format!("remote{i}")).unwrap();
    }
    let read_duration = start.elapsed();

    println!("Reading 1000 entities took: {read_duration:?}");

    // Operations should complete in reasonable time
    assert!(create_duration.as_secs() < 30);
    assert!(list_duration.as_secs() < 5);
    assert!(read_duration.as_secs() < 10);
}

#[test]
#[ignore = "Performance test"]
fn test_sub_settings_bulk_operations() {
    let fixture = TestFixture::with_sub_settings();
    let remotes = fixture.manager.sub_settings("remotes").unwrap();

    // Create some entities
    for i in 0..100 {
        remotes
            .set(&format!("remote{i}"), &json!({"id": i}))
            .unwrap();
    }

    // Measure bulk delete time
    let start = Instant::now();
    for i in 0..100 {
        remotes.delete(&format!("remote{i}")).unwrap();
    }
    let duration = start.elapsed();

    println!("Deleting 100 entities took: {duration:?}");
    assert!(duration.as_secs() < 5);

    // Verify all deleted
    let keys = remotes.list().unwrap();
    assert_eq!(keys.len(), 0);
}

// =============================================================================
// Concurrent Stress Tests
// =============================================================================

#[test]
#[ignore = "Performance test"]
fn test_high_concurrency_reads() {
    let fixture = Arc::new(TestFixture::new());
    let _ = fixture.manager.get_all().unwrap();

    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();

    let mut handles = vec![];

    let start = Instant::now();

    // 50 threads, each reading 100 times
    for _ in 0..50 {
        let fixture_clone = Arc::clone(&fixture);
        let handle = thread::spawn(move || {
            for _ in 0..100 {
                let _ = fixture_clone.manager.metadata().unwrap();
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    let duration = start.elapsed();
    println!("5000 concurrent reads (50 threads) took: {duration:?}");

    // Should handle high concurrency efficiently
    assert!(duration.as_secs() < 10);
}

#[test]
#[ignore = "Performance test"]
fn test_high_concurrency_writes() {
    let fixture = Arc::new(TestFixture::new());
    let _ = fixture.manager.get_all().unwrap();

    let mut handles = vec![];

    let start = Instant::now();

    // 20 threads, each writing 50 times
    for thread_id in 0..20 {
        let fixture_clone = Arc::clone(&fixture);
        let handle = thread::spawn(move || {
            for i in 0..50 {
                let theme = if (thread_id + i) % 2 == 0 {
                    "light"
                } else {
                    "dark"
                };
                fixture_clone
                    .manager
                    .save_setting("ui", "theme", &json!(theme))
                    .unwrap();
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    let duration = start.elapsed();
    println!("1000 concurrent writes (20 threads) took: {duration:?}");

    // Verify data integrity
    let metadata = fixture.manager.metadata().unwrap();
    let theme = metadata.get("ui.theme").unwrap();
    let value = theme.value.as_ref().unwrap().as_str().unwrap();
    assert!(value == "light" || value == "dark");

    assert!(duration.as_secs() < 30);
}

#[test]
#[ignore = "Performance test"]
fn test_mixed_concurrent_operations() {
    let fixture = Arc::new(TestFixture::new());
    let _ = fixture.manager.get_all().unwrap();

    let mut handles = vec![];

    let start = Instant::now();

    // 10 reader threads
    for _ in 0..10 {
        let fixture_clone = Arc::clone(&fixture);
        let handle = thread::spawn(move || {
            for _ in 0..100 {
                let _ = fixture_clone.manager.metadata().unwrap();
            }
        });
        handles.push(handle);
    }

    // 5 writer threads
    for thread_id in 0..5 {
        let fixture_clone = Arc::clone(&fixture);
        let handle = thread::spawn(move || {
            for i in 0..50 {
                let theme = if (thread_id + i) % 2 == 0 {
                    "light"
                } else {
                    "dark"
                };
                fixture_clone
                    .manager
                    .save_setting("ui", "theme", &json!(theme))
                    .unwrap();
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    let duration = start.elapsed();
    println!("Mixed workload (1000 reads + 250 writes) took: {duration:?}",);

    assert!(duration.as_secs() < 15);
}

// =============================================================================
// Memory Usage Tests
// =============================================================================

#[test]
#[ignore = "Performance test"]
fn test_memory_efficient_large_settings() {
    let fixture = TestFixture::with_sub_settings();
    let remotes = fixture.manager.sub_settings("remotes").unwrap();

    // Create settings with large JSON values
    for i in 0..100 {
        let large_config = json!({
            "type": "s3",
            "id": i,
            "metadata": {
                "description": "x".repeat(1000), // 1KB of text
                "tags": (0..100).map(|j| format!("tag-{j}")).collect::<Vec<_>>(),
                "data": (0..50).map(|_| json!({"nested": "value"})).collect::<Vec<_>>(),
            }
        });
        remotes.set(&format!("remote{i}"), &large_config).unwrap();
    }

    // Operations should complete without excessive memory usage
    // This is more of a manual inspection test - in production you'd use
    // memory profiling tools to verify actual usage

    println!("Created 100 entities with large JSON values");

    // Cleanup should work
    for i in 0..100 {
        remotes.delete(&format!("remote{i}")).unwrap();
    }

    println!("Successfully cleaned up all entities");
}

// =============================================================================
// Backup/Restore Performance
// =============================================================================

#[cfg(feature = "backup")]
#[test]
#[ignore = "Performance test"]
fn test_backup_large_settings() {
    use rcman::BackupOptions;
    use tempfile::TempDir;

    let fixture = TestFixture::with_sub_settings();
    let _ = fixture.manager.get_all().unwrap();

    // Create lots of data
    let remotes = fixture.manager.sub_settings("remotes").unwrap();
    for i in 0..500 {
        remotes
            .set(
                &format!("remote{i}"),
                &json!({"id": i, "data": "x".repeat(100)}),
            )
            .unwrap();
    }

    let backup_dir = TempDir::new().unwrap();

    let start = Instant::now();

    let backup_path = fixture
        .manager
        .backup()
        .create(&BackupOptions::new().output_dir(backup_dir.path()))
        .unwrap();

    let duration = start.elapsed();
    println!("Backing up 500 entities took: {duration:?}");

    let file_size = std::fs::metadata(&backup_path).unwrap().len();
    println!("Backup file size: {file_size} bytes");

    assert!(duration.as_secs() < 10);
}

#[cfg(feature = "backup")]
#[test]
#[ignore = "Performance test"]
fn test_restore_large_backup() {
    use rcman::{BackupOptions, RestoreOptions};
    use tempfile::TempDir;

    let fixture = TestFixture::with_sub_settings();
    let _ = fixture.manager.get_all().unwrap();

    // Create backup with data
    let remotes = fixture.manager.sub_settings("remotes").unwrap();
    for i in 0..500 {
        remotes
            .set(&format!("remote{i}"), &json!({"id": i}))
            .unwrap();
    }

    let backup_dir = TempDir::new().unwrap();
    let backup_path = fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .include_sub_settings("remotes"),
        )
        .unwrap();

    // Clear data
    for i in 0..500 {
        remotes.delete(&format!("remote{i}")).unwrap();
    }

    let start = Instant::now();

    // Restore
    fixture
        .manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path))
        .unwrap();

    let duration = start.elapsed();
    println!("Restoring 500 entities took: {duration:?}");

    // Verify data restored
    let keys = remotes.list().unwrap();
    assert_eq!(keys.len(), 500);

    assert!(duration.as_secs() < 10);
}
