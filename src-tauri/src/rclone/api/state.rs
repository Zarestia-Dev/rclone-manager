use once_cell::sync::Lazy;
use std::sync::Mutex;

const DEFAULT_RCLONE_API_PORT: &str = "5572";
const DEFAULT_RCLONE_OAUTH_PORT: &str = "5580";

// Stores the current Rclone API URL
pub static RCLONE_API_URL: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

// Stores the current Rclone OAuth URL
pub static RCLONE_OAUTH_URL: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
pub static RCLONE_OAUTH_PORT: Lazy<Mutex<u16>> = Lazy::new(|| Mutex::new(0));

/// Get the Rclone API URL based on the port
fn get_rclone_api_url(port: u16) -> String {
    if port == 0 {
        return format!("http://localhost:{}", DEFAULT_RCLONE_API_PORT);
    }
    format!("http://localhost:{}", port)
}

/// Get the Rclone OAuth URL based on the port
fn get_rclone_oauth_url(port: u16) -> String {
    if port == 0 {
        return format!("http://localhost:{}", DEFAULT_RCLONE_OAUTH_PORT);
    }
    format!("http://localhost:{}", port)
}

/// Set the Rclone API URL globally
pub fn set_rclone_api_url(port: u16) {
    let mut url = RCLONE_API_URL.lock().unwrap();
    *url = get_rclone_api_url(port);
}

/// Set the Rclone OAuth URL globally
pub fn set_rclone_oauth_url_port(port: u16) {
    let mut url = RCLONE_OAUTH_URL.lock().unwrap();
    *url = get_rclone_oauth_url(port);
    let mut oauth_port = RCLONE_OAUTH_PORT.lock().unwrap();
    *oauth_port = port;
}

/// Get the globally stored Rclone API URL
pub fn get_rclone_api_url_global() -> String {
    RCLONE_API_URL.lock().unwrap().clone()
}

/// Get the globally stored Rclone OAuth URL
pub fn get_rclone_oauth_url_global() -> String {
    RCLONE_OAUTH_URL.lock().unwrap().clone()
}

/// Get the globally stored Rclone OAuth port
pub fn get_rclone_oauth_port_global() -> u16 {
    *RCLONE_OAUTH_PORT.lock().unwrap()
}