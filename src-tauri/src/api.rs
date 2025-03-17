use std::{collections::HashMap, fs, path::PathBuf};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::command;

const RCLONE_API_URL: &str = "http://localhost:5572";

pub async fn is_rc_api_running() -> bool {
    let client = reqwest::Client::new();

    match client.get(RCLONE_API_URL).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
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
pub async fn save_mount_config(remote: String, mount_path: String, options: HashMap<String, serde_json::Value>) -> Result<(), String> {
    let mut mounts: Vec<MountConfig> = match fs::read_to_string(mount_config_path()) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => vec![],
    };
    print!("{:?}", dirs::config_dir().unwrap().join("rclone-manager/mounts.json"));
    mounts.push(MountConfig {
        remote,
        mount_path,
        options,
    });

    fs::write(mount_config_path(), serde_json::to_string_pretty(&mounts).unwrap())
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get saved mount configurations
#[command]
pub async fn get_saved_mount_configs() -> Result<Vec<MountConfig>, String> {
    let content = fs::read_to_string(mount_config_path()).unwrap_or_else(|_| "[]".to_string());
    let mounts: Vec<MountConfig> = serde_json::from_str(&content).unwrap_or_default();
    Ok(mounts)
}

#[command]
pub async fn create_remote(name: String, parameters: HashMap<String, serde_json::Value>) -> Result<(), String> {
    let client = Client::new();
    let body = serde_json::json!({
        "name": name,
        "type": parameters.get("type").unwrap_or(&serde_json::Value::String("".to_string())),
        "parameters": parameters
    });

    client
        .post("http://localhost:5572/config/create")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update an existing remote
#[command]
pub async fn update_remote(name: String, parameters: HashMap<String, serde_json::Value>) -> Result<(), String> {
    let client = Client::new();
    let body = serde_json::json!({ "name": name, "parameters": parameters });

    client
        .post("http://localhost:5572/config/update")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete a remote
#[command]
pub async fn delete_remote(name: String) -> Result<(), String> {
    let client = Client::new();
    client
        .post(format!("http://localhost:5572/config/delete?name={}", name))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}


#[command]
pub async fn get_mount_types() -> Result<Vec<String>, String> {
    let client = Client::new();
    let url = format!("{}/mount/types", RCLONE_API_URL);

    let response = client.post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to request mount types: {}", e))?;

    let json: Value = response.json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(types) = json.get("mountTypes").and_then(|t| t.as_array()) {
        Ok(types.iter().filter_map(|t| t.as_str().map(String::from)).collect())
    } else {
        Err("Invalid response format".to_string())
    }
}

/// Fetch mount options for a specific mount type
/// Fetch all available options from Rclone RC API
#[command]
pub async fn get_mount_options() -> Result<Vec<Value>, String> {
    let client = Client::new();
    let url = format!("{}/options/info", RCLONE_API_URL);

    let response = client.post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to request options info: {}", e))?;

    let json: Value = response.json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    // Extract the mount-specific options from the "mount" key
    if let Some(mount_options) = json.get("mount").and_then(|m| m.as_array()) {
        Ok(mount_options.clone())
    } else {
        Err("Mount options not found in response".to_string())
    }
}


/// Fetch remote config fields dynamically
#[command]
pub async fn get_remote_config_fields(remote_type: String) -> Result<Vec<Value>, String> {
    let client = Client::new();
    let url = format!("{}/config/providers", RCLONE_API_URL);

    let response = client.post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote config fields: {}", e))?;

    let json: Value = response.json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(providers) = json.get("providers").and_then(|p| p.as_array()) {
        let fields = providers.iter()
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
pub async fn get_remote_config(remote_name: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:5572/config/get?name={}", remote_name);

    let response = client
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
pub async fn get_all_remote_configs() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = "http://localhost:5572/config/dump"; // ✅ Fetch all remotes at once

    let response = client
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
pub async fn list_mounts() -> Result<Vec<String>, String> {
    let client = Client::new();
    let url = format!("{}/mount/listmounts", RCLONE_API_URL);

    let response = client
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
pub async fn get_mounted_remotes() -> Result<Vec<MountedRemote>, String> {
    let client = Client::new();
    let url = format!("{}/mount/listmounts", RCLONE_API_URL);

    let response = client
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
pub async fn get_remotes() -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = "http://localhost:5572/config/listremotes";

    let response = client
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

#[command]
pub async fn mount_remote(remote_name: String, mount_point: String) -> Result<String, String> {
    let client = Client::new();
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

    print!("{:?}", params);

    let response = client.post(&url).json(&params).send().await;

    match response {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_else(|_| "No response body".to_string());

            if status.is_success() {
                Ok(format!("✅ Mounted '{}' to '{}'", remote_name, mount_point))
            } else {
                Err(format!("❌ Failed to mount '{}': {} (HTTP {})", remote_name, body, status))
            }
        }
        Err(e) => {
            Err(format!("🚨 Request Error: Failed to send mount request: {}", e))
        }
    }
}

#[command]
pub async fn unmount_remote(mount_point: String) -> Result<String, String> {
    let client = Client::new();
    let url = format!("{}/mount/unmount", RCLONE_API_URL);

    let params = serde_json::json!({ "mountPoint": mount_point });

    let response = client
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
