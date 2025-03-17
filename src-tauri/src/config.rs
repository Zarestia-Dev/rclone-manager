use serde::{Serialize, Deserialize};
use tauri::command;
use tauri_plugin_opener::OpenerExt;
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Debug)]
pub struct Config {
    pub use_rc_api: bool,  // true = RC API, false = Rust threads
}

const CONFIG_PATH: &str = "config.json";

pub fn load_config() -> Config {
    if Path::new(CONFIG_PATH).exists() {
        let config_data = fs::read_to_string(CONFIG_PATH).expect("Failed to read config");
        serde_json::from_str(&config_data).expect("Failed to parse config")
    } else {
        Config { use_rc_api: true }  // Default to RC API
    }
}

pub fn save_config(config: &Config) {
    let config_data = serde_json::to_string_pretty(config).expect("Failed to serialize config");
    fs::write(CONFIG_PATH, config_data).expect("Failed to save config");
}

#[command]
pub async fn open_in_files(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if path.is_empty() {
        return Err("Invalid path: Path cannot be empty.".to_string());
    }

    match app.opener().open_path(path.clone(), None::<&str>) {
        Ok(_) => Ok(format!("Opened file manager at {}", path)),
        Err(e) => Err(format!("Failed to open file manager: {}", e)),
    }
}