use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;
use reqwest::Client;

#[derive(Debug, Deserialize, Serialize)]
pub struct RemoteProvider {
    pub Name: String,
    pub Description: String,
    pub Options: Vec<RemoteOption>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RemoteOption {
    pub Name: String,
    pub Help: String,
    pub Required: bool,
}

/// State struct for managing HTTP client instance
pub struct RcloneState {
    pub client: Client,
}

#[tauri::command]
pub async fn get_remote_types(state: State<'_, RcloneState>) -> Result<HashMap<String, Vec<RemoteProvider>>, String> {
    let url = "http://localhost:5572/config/providers";
    
    let response = state.client.post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;
    
    let providers: HashMap<String, Vec<RemoteProvider>> = response.json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(providers)
}
