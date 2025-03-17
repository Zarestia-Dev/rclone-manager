use sysinfo::Disks;
use serde::Serialize;

#[derive(Serialize)]
pub struct DiskUsage {
    total_space: String,
    used_space: String,
    free_space: String,
}

#[tauri::command]
pub fn get_disk_usage(mount_point: String) -> Result<DiskUsage, String> {
    let disks = Disks::new_with_refreshed_list();
    
    for disk in disks.list() {
        let path = disk.mount_point().to_string_lossy().to_string();
        if path == mount_point {
            let total_space = disk.total_space();
            let available_space = disk.available_space();
            let used_space = total_space - available_space;

            return Ok(DiskUsage {
                total_space: format_size(total_space),
                used_space: format_size(used_space),
                free_space: format_size(available_space),
            });
        }
    }

    Err("Mount point not found".to_string())
}

/// Helper function to format bytes into human-readable sizes
fn format_size(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        format!("{:.2} GB", bytes as f64 / 1_000_000_000.0)
    } else if bytes >= 1_000_000 {
        format!("{:.2} MB", bytes as f64 / 1_000_000.0)
    } else {
        format!("{:.2} KB", bytes as f64 / 1_000.0)
    }
}
