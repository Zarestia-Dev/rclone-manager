use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    error::Error,
    fs,
    path::PathBuf,
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::command;
use tauri::State;

const RCLONE_API_URL: &str = "http://localhost:5572";

pub struct RcloneState {
    pub client: Client,
}

pub fn is_rc_api_running() -> bool {
    let client = reqwest::blocking::Client::new();
    match client
        .post(format!("{}/config/listremotes", RCLONE_API_URL))
        .send()
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

pub fn start_rc_api() -> Child {
    println!("Starting Rclone RC API...");
    Command::new("rclone")
        .args(&[
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            "--rc-addr=localhost:5572",
        ])
        .spawn()
        .expect("Failed to start Rclone RC API")
}

pub fn ensure_rc_api_running(rc_process: Arc<Mutex<Option<Child>>>) {
    thread::spawn(move || {
        loop {
            if !is_rc_api_running() {
                println!("Rclone RC API is down! Restarting...");
                let child = start_rc_api();
                let mut process_guard = rc_process.lock().unwrap();
                *process_guard = Some(child);
            }
            thread::sleep(Duration::from_secs(10)); // Check every 10 seconds
        }
    });
}

#[command]
pub async fn get_all_remote_configs(
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/config/dump", RCLONE_API_URL);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote configs: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(json)
}

#[command]
pub async fn get_all_mount_configs() -> Result<Vec<MountConfig>, String> {
    let content = fs::read_to_string(mount_config_path()).unwrap_or_else(|_| "[]".to_string());
    let mounts: Vec<MountConfig> = serde_json::from_str(&content).unwrap_or_default();
    Ok(mounts)
}

#[command]
pub async fn get_remotes(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let url = format!("{}/config/listremotes", RCLONE_API_URL);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remotes: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let remotes = json["remotes"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|v| v.as_str().unwrap_or("").to_string())
        .collect();

    print!("{:?}", remotes);

    Ok(remotes)
}

#[derive(Serialize, Deserialize)]
pub struct MountConfig {
    remote: String,
    mount_path: String,
    options: HashMap<String, serde_json::Value>,
}

// Path for storing mount configurations
fn mount_config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap()
        .join("rclone-manager/mounts.json")
}

/// Save mount configuration
#[command]
pub async fn save_mount_config(
    remote: String,
    mount_path: String,
    options: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let path = mount_config_path();
    let dir = path.parent().unwrap();

    // Ensure the config directory exists
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let mut mounts: Vec<MountConfig> = match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => vec![], // If file doesn't exist, start with an empty list
    };

    // Check if the mount already exists
    if let Some(existing) = mounts.iter_mut().find(|m| m.remote == remote) {
        // Update existing mount configuration
        existing.mount_path = mount_path.clone();
        existing.options = options.clone();
        println!("Updated existing mount config for: {}", remote);
    } else {
        // Add new mount configuration
        mounts.push(MountConfig {
            remote: remote.clone(),
            mount_path: mount_path.clone(),
            options: options.clone(),
        });
        println!("Added new mount config for: {}", remote);
    }

    // Save the updated mounts list back to the file
    fs::write(&path, serde_json::to_string_pretty(&mounts).unwrap())
        .map_err(|e| format!("Failed to write mount config: {}", e))?;

    println!("Mount config saved at: {:?}", path); // Debug print

    Ok(())
}

/// Get saved mount configurations

#[command]
pub async fn get_saved_mount_config(remote: String) -> Result<Option<MountConfig>, String> {
    let mounts: Vec<MountConfig> = match fs::read_to_string(mount_config_path()) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => vec![], // If file doesn't exist, return an empty vec
    };

    // Find the mount config that matches the given remote name
    let mount_config = mounts.into_iter().find(|m| m.remote == remote);

    Ok(mount_config)
}

#[command]
pub async fn create_remote(
    name: String,
    parameters: HashMap<String, serde_json::Value>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let body = serde_json::json!({
        "name": name,
        "type": parameters.get("type").unwrap_or(&serde_json::Value::String("".to_string())),
        "parameters": parameters
    });

    state
        .client
        .post("http://localhost:5572/config/create")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update an existing remote
#[command]
pub async fn update_remote(
    name: String,
    parameters: HashMap<String, serde_json::Value>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let body = serde_json::json!({ "name": name, "parameters": parameters });

    state
        .client
        .post("http://localhost:5572/config/update")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete a remote
#[command]
pub async fn delete_remote(name: String, state: State<'_, RcloneState>) -> Result<(), String> {
    state
        .client
        .post(format!("http://localhost:5572/config/delete?name={}", name))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn get_mount_types(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let url = format!("{}/mount/types", RCLONE_API_URL);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to request mount types: {}", e))?;

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(types) = json.get("mountTypes").and_then(|t| t.as_array()) {
        Ok(types
            .iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect())
    } else {
        Err("Invalid response format".to_string())
    }
}

/// Fetch remote config fields dynamically
#[command]
pub async fn get_remote_config_fields(
    remote_type: String,
    state: State<'_, RcloneState>,
) -> Result<Vec<Value>, String> {
    let url = format!("{}/config/providers", RCLONE_API_URL);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote config fields: {}", e))?;

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(providers) = json.get("providers").and_then(|p| p.as_array()) {
        let fields = providers
            .iter()
            .find(|provider| provider.get("Name") == Some(&Value::String(remote_type.clone())))
            .and_then(|provider| provider.get("Options").cloned());

        match fields {
            Some(fields) => Ok(fields.as_array().cloned().unwrap_or_else(Vec::new)),
            None => Err("Remote type not found".to_string()),
        }
    } else {
        Err("Invalid response format".to_string())
    }
}

#[command]
pub async fn get_remote_config(
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = format!("http://localhost:5572/config/get?name={}", remote_name);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote config: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(json)
}

#[command]
pub async fn list_mounts(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let url = format!("{}/mount/listmounts", RCLONE_API_URL);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to list mounts: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mount_points = json["mountPoints"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|v| v.as_str().unwrap_or("").to_string())
        .collect();

    Ok(mount_points)
}

#[derive(Serialize, Deserialize)]
pub struct MountedRemote {
    fs: String,
    mount_point: String,
}

#[tauri::command]
pub async fn get_mounted_remotes(
    state: State<'_, RcloneState>,
) -> Result<Vec<MountedRemote>, String> {
    let url = format!("{}/mount/listmounts", RCLONE_API_URL);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch mounted remotes: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mounts = json["mountPoints"]
        .as_array()
        .unwrap_or(&vec![]) // Default to an empty list if not found
        .iter()
        .filter_map(|mp| {
            Some(MountedRemote {
                fs: mp["Fs"].as_str()?.to_string(),
                mount_point: mp["MountPoint"].as_str()?.to_string(),
            })
        })
        .collect();

    Ok(mounts)
}

#[command]
pub async fn mount_remote(
    remote_name: String,
    mount_point: String,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let url = format!("{}/mount/mount", RCLONE_API_URL);

    let formatted_remote = if remote_name.ends_with(':') {
        remote_name.clone()
    } else {
        format!("{}:", remote_name)
    };

    let params = serde_json::json!({
        "fs": formatted_remote,
        "mountPoint": mount_point
    });

    // Check if the mount point path exists, create it if it doesn't
    let mount_path = PathBuf::from(&mount_point);
    if !mount_path.exists() {
        fs::create_dir_all(&mount_path).map_err(|e| {
            format!(
                "❌ Failed to create mount point path '{}': {}",
                mount_point, e
            )
        })?;
    }
    let response = state.client.post(&url).json(&params).send().await;

    match response {
        Ok(resp) => {
            let status = resp.status();
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "No response body".to_string());

            if status.is_success() {
                Ok(format!("✅ Mounted '{}' to '{}'", remote_name, mount_point))
            } else {
                Err(format!(
                    "❌ Failed to mount '{}': {} (HTTP {})",
                    remote_name, body, status
                ))
            }
        }
        Err(e) => Err(format!(
            "🚨 Request Error: Failed to send mount request: {}",
            e
        )),
    }
}

#[command]
pub async fn unmount_remote(
    mount_point: String,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let url = format!("{}/mount/unmount", RCLONE_API_URL);

    let params = serde_json::json!({ "mountPoint": mount_point });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to unmount remote: {}", e))?;

    if response.status().is_success() {
        Ok(format!("Unmounted {}", mount_point))
    } else {
        Err(format!("Failed to unmount: {:?}", response.text().await))
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiskUsage {
    free: String,
    used: String,
    total: String,
}
#[command]
pub async fn get_disk_usage(
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    let url = format!("{}/operations/about", RCLONE_API_URL);

    let response = state
        .client
        .post(&url)
        .json(&json!({ "fs": format!("{}:", remote_name) }))
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        let error_msg = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Failed to fetch disk usage: {}", error_msg));
    }

    let json_response: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let free = json_response["free"].as_u64().unwrap_or(0);
    let used = json_response["used"].as_u64().unwrap_or(0);
    let total = json_response["total"].as_u64().unwrap_or(0);

    Ok(DiskUsage {
        free: format_size(free),
        used: format_size(used),
        total: format_size(total),
    })
}

/// 📌 **Improved Formatting Function**
fn format_size(bytes: u64) -> String {
    let sizes = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut i = 0;

    while size >= 1024.0 && i < sizes.len() - 1 {
        size /= 1024.0;
        i += 1;
    }

    format!("{:.2} {}", size, sizes[i])
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")] // ✅ Convert JSON PascalCase to Rust snake_case automatically
pub struct RemoteProvider {
    pub name: String,
    pub description: String,
    pub options: Vec<RemoteOption>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")] // ✅ Convert JSON PascalCase to Rust automatically
pub struct RemoteOption {
    pub name: String,       // "Name": "client_id"
    pub help: String,       // "Help": "Google Application Client Id..."
    pub required: bool,     // "Required": false
    pub value: Option<String>,  // "Value": null or some default
    pub r#type: Option<String>, // "Type": "string", "bool", etc.
}

/// State struct for managing HTTP client instance

#[tauri::command]
pub async fn get_remote_types(
    state: State<'_, RcloneState>,
) -> Result<HashMap<String, Vec<RemoteProvider>>, String> {
    let url = format!("{}/config/providers", RCLONE_API_URL);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let providers: HashMap<String, Vec<RemoteProvider>> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(providers)
}

// FLAGS

async fn fetch_rclone_options(
    endpoint: &str,
    state: State<'_, RcloneState>,
) -> Result<Value, Box<dyn Error>> {
    let url = format!("{}/options/{}", RCLONE_API_URL, endpoint);

    let response = state
        .client
        .post(&url)
        .json(&json!({})) // Empty JSON body
        .send()
        .await?;

    if response.status().is_success() {
        let json: Value = response.json().await?;
        Ok(json)
    } else {
        Err(format!("Failed to fetch data: {:?}", response.text().await?).into())
    }
}

/// Fetch all global flags
#[command]
pub async fn get_global_flags(state: State<'_, RcloneState>) -> Result<Value, String> {
    fetch_rclone_options("get", state)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch copy flags
#[command]
pub async fn get_copy_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = Vec::new();
    let main_flags = json["main"].as_array().unwrap_or(&empty_vec);

    let copy_flags: Vec<Value> = main_flags
        .iter()
        .filter(|flag| {
            if let Some(groups) = flag["Groups"].as_str() {
                groups.contains("Copy") || groups.contains("Performance")
            } else {
                false
            }
        })
        .cloned()
        .collect();

    Ok(copy_flags)
}

/// Fetch sync flags
#[command]
pub async fn get_sync_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = Vec::new();
    let main_flags = json["main"].as_array().unwrap_or(&empty_vec);

    let sync_flags: Vec<Value> = main_flags
        .iter()
        .filter(|flag| {
            if let Some(groups) = flag["Groups"].as_str() {
                groups.contains("Copy") || groups.contains("Sync") || groups.contains("Performance")
            } else {
                false
            }
        })
        .cloned()
        .collect();

    Ok(sync_flags)
}

/// Fetch filter flags (excluding metadata)
#[command]
pub async fn get_filter_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = vec![];
    let filter_flags = json["filter"].as_array().unwrap_or(&empty_vec);

    let filtered_flags: Vec<Value> = filter_flags
        .iter()
        .filter(|flag| {
            static EMPTY_VEC: Vec<Value> = Vec::new();
            let groups = flag["Groups"].as_array().unwrap_or(&EMPTY_VEC);
            !groups.iter().any(|g| g == "Metadata")
        })
        .cloned()
        .collect();

    Ok(filtered_flags)
}

/// Fetch VFS flags (excluding ignored flags)
#[command]
pub async fn get_vfs_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = vec![];
    let vfs_flags = json["vfs"].as_array().unwrap_or(&empty_vec);

    let ignored_flags = vec!["NONE"];
    let filtered_flags: Vec<Value> = vfs_flags
        .iter()
        .filter(|flag| {
            let name = flag["Name"].as_str().unwrap_or("");
            !ignored_flags.contains(&name)
        })
        .cloned()
        .collect();

    Ok(filtered_flags)
}

/// Fetch mount flags (excluding specific ignored flags)
#[command]
pub async fn get_mount_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = vec![];
    let mount_flags = json["mount"].as_array().unwrap_or(&empty_vec);

    let ignored_flags = vec!["debug_fuse", "daemon", "daemon_timeout"];
    let filtered_flags: Vec<Value> = mount_flags
        .iter()
        .filter(|flag| {
            let name = flag["Name"].as_str().unwrap_or("");
            !ignored_flags.contains(&name)
        })
        .cloned()
        .collect();

    Ok(filtered_flags)
}
