use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::sleep;
use std::{
    collections::HashMap,
    error::Error,
    process::{Child, Command, Stdio},
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



lazy_static::lazy_static! {
    static ref OAUTH_PROCESS: Arc<tokio::sync::Mutex<Option<Child>>> = Arc::new(tokio::sync::Mutex::new(None));
}

#[tauri::command]
pub async fn create_remote(
    name: String,
    parameters: serde_json::Value,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // ✅ Acquire the lock first
    {
        let guard = OAUTH_PROCESS.lock().await;
        if guard.is_some() {
            println!("🔴 Stopping existing OAuth authentication process...");
            drop(guard); // ✅ Release the lock here
            quit_rclone_oauth().await?; // ✅ Call quit AFTER releasing the lock
        }
    } // ✅ Guard is dropped when this scope ends

    // ✅ Start a new Rclone instance
    let rclone_process = Command::new("rclone")
        .args([
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            "--rc-addr", "localhost:5580", 
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start separate Rclone instance: {}", e))?;

    println!("✅ Started Rclone OAuth instance with PID: {:?}", rclone_process.id());

    // ✅ Lock again and store the new process
    {
        let mut guard = OAUTH_PROCESS.lock().await;
        *guard = Some(rclone_process);
    }

    // ✅ Give Rclone a moment to start
    sleep(Duration::from_secs(2)).await;

    let client = &state.client;
    let body = serde_json::json!({
        "name": name,
        "type": remote_type,
        "parameters": parameters
    });

    let response = client
        .post("http://localhost:5580/config/create")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let response_text = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;

    // ✅ Detect OAuth errors
    if response_text.contains("failed to get oauth token") {
        return Err("OAuth authentication was not completed. Please authenticate in the browser.".to_string());
    }
    if response_text.contains("bind: address already in use") {
        return Err("OAuth authentication failed because the port is already in use.".to_string());
    }
    if response_text.contains("couldn't find type field in config") {
        return Err("Configuration update failed due to a missing type field.".to_string());
    }

    Ok(())
}


#[tauri::command]
pub async fn quit_rclone_oauth() -> Result<(), String> {
    println!("🔒 Locking Rclone OAuth process...");

    let mut guard = OAUTH_PROCESS.lock().await;
    if guard.is_none() {
        println!("⚠️ No active Rclone OAuth process found.");
        return Err("No active Rclone OAuth process found.".to_string());
    }

    let client = reqwest::Client::new();
    let url = "http://localhost:5580/core/quit";

    println!("🛑 Stopping Rclone OAuth instance...");

    // ✅ Send graceful shutdown command
    let response = client.post(url).send().await;

    match response {
        Ok(_) => println!("✅ Rclone OAuth instance exited cleanly via API."),
        Err(e) => println!("⚠️ Failed to quit via RC API: {}", e),
    }

    // ✅ Wait for the process to exit or force kill it
    if let Some(mut process) = guard.take() {
        println!("🔍 Checking Rclone process PID: {:?}", process.id());

        match process.wait() {
            Ok(status) => {
                println!("✅ Rclone OAuth process exited with status: {:?}", status);
            }
            Err(_) => {
                println!("⚠️ Rclone OAuth process still running. Killing...");
                if let Err(e) = process.kill() {
                    println!("💀 Failed to kill Rclone OAuth process: {}", e);
                    return Err(format!("Failed to terminate Rclone OAuth process: {}", e));
                } else {
                    println!("💀 Force-killed Rclone OAuth process.");
                }
            }
        }
    }

    println!("✅ Rclone OAuth shutdown complete.");
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
    let url = format!("{}/config/update", RCLONE_API_URL);

    state
        .client
        .post(&url)
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
        .post(format!("{}/config/delete?name={}", RCLONE_API_URL, name))
        .send()
        .await
        .map_err(|e| e.to_string())?;


    Ok(())
}

// #[command]
// pub async fn get_mount_types(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
//     let url = format!("{}/mount/types", RCLONE_API_URL);

//     let response = state
//         .client
//         .post(&url)
//         .send()
//         .await
//         .map_err(|e| format!("Failed to request mount types: {}", e))?;

//     let json: Value = response
//         .json()
//         .await
//         .map_err(|e| format!("Failed to parse response: {}", e))?;

//     if let Some(types) = json.get("mountTypes").and_then(|t| t.as_array()) {
//         Ok(types
//             .iter()
//             .filter_map(|t| t.as_str().map(String::from))
//             .collect())
//     } else {
//         Err("Invalid response format".to_string())
//     }
// }

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
    let url = format!("{}/config/get?name={}", RCLONE_API_URL, remote_name);

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


///  Operations (Mount/Unmount etc)

#[command]
pub async fn mount_remote(
    remote_name: String,
    mount_point: String,
    mount_options: Option<HashMap<String, serde_json::Value>>,
    vfs_options: Option<HashMap<String, serde_json::Value>>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let url = format!("{}/mount/mount", RCLONE_API_URL);

    
    let formatted_remote = if remote_name.ends_with(':') {
        remote_name.clone()
    } else {
        format!("{}:", remote_name)
    };

    // Build JSON payload
    let mut payload = json!({
        "fs": formatted_remote,
        "mountPoint": mount_point,
    });

    // Add mount options if provided
    if let Some(mount_opts) = mount_options {
        payload["mountOpt"] = json!(mount_opts);
    }

    // Add VFS options if provided
    if let Some(vfs_opts) = vfs_options {
        payload["vfsOpt"] = json!(vfs_opts);
    }

    // Send HTTP POST request
    let response = state.client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    // Parse response
    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "No response body".to_string());

    if status.is_success() {
        println!("✅ Mount request successful: {}", body);
        Ok(())
    } else {
        Err(format!(
            "❌ Mount request failed: {} (HTTP {})",
            body, status
        ))
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
#[serde(rename_all = "PascalCase")]
pub struct RemoteExample {
    pub value: String,
    pub help: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct RemoteOption {
    pub name: String,       
    pub help: String,       
    pub required: bool,     
    pub value: Option<String>,  
    pub r#type: Option<String>, 

    #[serde(default)] // If missing, use default empty vector
    pub examples: Vec<RemoteExample>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct RemoteProvider {
    pub name: String,
    pub description: String,
    pub prefix: String,
    pub options: Vec<RemoteOption>,
}

/// ✅ Fetch remote providers (cached for reuse)
async fn fetch_remote_providers(state: &State<'_, RcloneState>) -> Result<HashMap<String, Vec<RemoteProvider>>, String> {
    let url = format!("{}/config/providers", RCLONE_API_URL);
    
    let response = state.client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;
    
    let body = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
    let providers: HashMap<String, Vec<RemoteProvider>> = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(providers)
}

/// ✅ Fetch all remote types
#[tauri::command]
pub async fn get_remote_types(state: State<'_, RcloneState>) -> Result<HashMap<String, Vec<RemoteProvider>>, String> {
    fetch_remote_providers(&state).await
}

/// ✅ Fetch only OAuth-supported remotes
#[tauri::command]
pub async fn get_oauth_supported_remotes(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let providers = fetch_remote_providers(&state).await?;

    // ✅ Extract OAuth-supported remotes
    let oauth_remotes: Vec<String> = providers.into_values()
        .flatten()
        .filter(|remote| {
            remote.options.iter().any(|opt| 
                opt.name == "token" && opt.help.contains("OAuth Access Token as a JSON blob.")
            )
        })
        .map(|remote| remote.name.clone()) // Clone the name string
        .collect();

    Ok(oauth_remotes)
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
