use dirs::home_dir;
use reqwest::Client;
use tokio::runtime::Runtime;
use std::process::{Command, Stdio};

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use crate::api::{is_rc_api_running, list_mounts};

use serde::{Serialize, Deserialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MountConfig {
    remote: String,
    mount_point: String,
    options: Option<String>,
}

lazy_static::lazy_static! {
    static ref MOUNT_CONFIG: Mutex<Vec<MountConfig>> = Mutex::new(Vec::new());
}

/// Get the file path for storing mount configurations
fn get_config_file_path() -> PathBuf {
    let home = home_dir().expect("Failed to get home directory");
    home.join(".config/rclone_manager/mounts.json")
}

/// Save mount configurations to JSON
fn save_mount_configs() -> Result<(), String> {
    let config_path = get_config_file_path();
    let data = serde_json::to_string_pretty(&*MOUNT_CONFIG.lock().unwrap())
        .map_err(|e| format!("Failed to serialize mount config: {}", e))?;
    
    fs::write(&config_path, data).map_err(|e| format!("Failed to save mount config: {}", e))
}

/// Load mount configurations from JSON
fn load_mount_configs() -> Result<(), String> {
    let config_path = get_config_file_path();

    if !config_path.exists() {
        return Ok(()); // No config file yet, so return an empty list
    }

    let data = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read mount config: {}", e))?;

    let mounts: Vec<MountConfig> = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse mount config: {}", e))?;

    *MOUNT_CONFIG.lock().unwrap() = mounts;
    Ok(())
}

/// Add a new mount configuration
#[tauri::command]
pub fn add_mount(remote: String, mount_point: String, options: Option<String>) -> Result<(), String> {
    let mut mounts = MOUNT_CONFIG.lock().unwrap();

    mounts.push(MountConfig {
        remote,
        mount_point,
        options,
    });

    save_mount_configs()
}

/// Get all stored mount configurations
#[tauri::command]
pub fn get_mount_configs() -> Result<Vec<MountConfig>, String> {
    load_mount_configs()?;
    Ok(MOUNT_CONFIG.lock().unwrap().clone())
}

/// Remove a mount configuration
#[tauri::command]
pub fn remove_mount(remote: String) -> Result<(), String> {
    let mut mounts = MOUNT_CONFIG.lock().unwrap();
    mounts.retain(|m| m.remote != remote);
    save_mount_configs()
}

pub fn start_mount_tracker(stop_signal: Arc<Mutex<bool>>) {
    let rt = Runtime::new().expect("Failed to create Tokio runtime");

    std::thread::spawn(move || {
        let _client = Client::new();

        // Wait for RC API to be available (max 10 retries)
        for _ in 0..10 {
            if rt.block_on(is_rc_api_running()) {
                println!("Rclone RC API is up.");
                break;
            }
            eprintln!("Waiting for Rclone RC API to start...");
            std::thread::sleep(Duration::from_secs(5));
        }

        loop {
            {
                let stop = stop_signal.lock().unwrap();
                if *stop {
                    println!("Stopping mount tracker...");
                    break;
                }
            }

            match rt.block_on(list_mounts()) {
                Ok(mounts) => println!("Active Mounts: {:?}", mounts),
                Err(e) => eprintln!("Error tracking mounts: {}", e),
            }

            std::thread::sleep(Duration::from_secs(10));
        }
    });
}


pub fn mount_remote_rust(remote: &str, mount_point: &str) -> Result<String, String> {
    let output = Command::new("rclone")
        .args(["mount", remote, mount_point])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match output {
        Ok(_) => Ok(format!("Mounted {} to {} (Rust Thread)", remote, mount_point)),
        Err(e) => Err(format!("Failed to mount: {}", e)),
    }
}

pub fn unmount_remote_rust(mount_point: &str) -> Result<String, String> {
    let output = Command::new("fusermount")
        .args(["-u", mount_point])
        .output();

    match output {
        Ok(_) if output.unwrap().status.success() => Ok(format!("Unmounted {}", mount_point)),
        _ => Err(format!("Failed to unmount {}", mount_point)),
    }
}
