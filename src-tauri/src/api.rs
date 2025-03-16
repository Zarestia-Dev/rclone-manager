use reqwest::Client;
use serde_json::Value;
use tauri::command;

const RCLONE_API_URL: &str = "http://localhost:5572";

pub async fn is_rc_api_running() -> bool {
    let client = reqwest::Client::new();

    match client.get(RCLONE_API_URL).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
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
pub async fn mount_remote(remote: String, mount_point: String) -> Result<String, String> {
    let client = Client::new();
    let url = format!("{}/mount/mount", RCLONE_API_URL);

    let params = serde_json::json!({ "fs": remote, "mountPoint": mount_point });

    let response = client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to mount remote: {}", e))?;

    if response.status().is_success() {
        Ok(format!("Mounted {} to {}", remote, mount_point))
    } else {
        Err(format!("Failed to mount: {:?}", response.text().await))
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
