// Backend types for rclone manager
//
// Simplified flat structure - no nested types.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use rcman::{SettingMetadata, SettingsSchema, settings};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BackendConnectionSchema;

impl SettingsSchema for BackendConnectionSchema {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "is_local" => SettingMetadata::toggle(true)
                .meta_str("label", "Local Backend")
                .meta_str("description", "Whether this backend is managed locally by the application")
                .meta_str("input_type", "checkbox")
                .meta_str("group", "system")
                .meta_bool("readonly", true),

            "host" => SettingMetadata::text("127.0.0.1")
                .meta_str("label", "Host")
                .meta_str("description", "Hostname or IP address of the rclone instance")
                .meta_str("placeholder", "e.g. 127.0.0.1 or my-nas.local")
                .meta_str("input_type", "text")
                .meta_str("group", "connection")
                .meta_num("order", 10.0),

            "port" => SettingMetadata::number(51900.0)
                .min(1.0).max(65535.0)
                .meta_str("label", "Port")
                .meta_str("placeholder", "51900")
                .meta_str("input_type", "number")
                .meta_str("group", "connection")
                .meta_num("order", 20.0),

            "username" => SettingMetadata::text("")
                .meta_str("label", "Username")
                .meta_str("placeholder", "Leave empty for no auth")
                .meta_str("input_type", "text")
                .meta_str("group", "authentication")
                .meta_num("order", 30.0),

            "password" => SettingMetadata::text("")
                .secret()
                .meta_str("label", "Password")
                .meta_str("placeholder", "Leave empty for no auth")
                .meta_str("input_type", "password")
                .meta_str("group", "authentication")
                .meta_num("order", 40.0),

            "oauth_port" => SettingMetadata::number(51901.0)
                .min(1.0).max(65535.0)
                .meta_str("label", "OAuth Port")
                .meta_str("description", "Port used for OAuth callbacks (Local backend only)")
                .meta_str("input_type", "number")
                .meta_str("group", "oauth")
                .meta_num("order", 50.0),

            "config_password" => SettingMetadata::text("")
                .secret()
                .meta_str("label", "Config Password")
                .meta_str("description", "Password for encrypted configuration file")
                .meta_str("input_type", "password")
                .meta_str("group", "security")
                .meta_num("order", 60.0),

            "config_path" => SettingMetadata::text("")
                .meta_str("label", "Config Path")
                .meta_str("description", "Specific path to rclone.conf (optional)")
                .meta_str("placeholder", "Leave empty to use default")
                .meta_str("input_type", "file_path")
                .meta_str("group", "advanced")
                .meta_num("order", 70.0),
        }
    }
}

/// Single flat backend configuration
///
/// Represents a connection to an rclone RC API server.
/// - Local: Managed by the app (starts/stops the process)
/// - Remote: External rclone rcd instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backend {
    /// Unique name/identifier (used as key, skipped in serialization)
    #[serde(skip)]
    pub name: String,

    /// True = managed by app (Local), False = external (Remote)
    #[serde(default)]
    pub is_local: bool,

    /// Host address (e.g., "127.0.0.1")
    pub host: String,

    /// RC API port (e.g., 51900)
    pub port: u16,

    /// RC API username (for --rc-user)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,

    /// RC API password (for --rc-pass) - stored in keychain, not JSON
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,

    /// OAuth port for local backends (same host, different port)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_port: Option<u16>,

    /// Config password for encrypted remote configs - stored in keychain
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_password: Option<String>,

    /// Config file path (for remote backends mostly) - optional
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,

    /// Rclone version (runtime only - fetched from core/version)
    #[serde(skip)]
    pub version: Option<String>,

    /// OS rclone is running on (runtime only - fetched from core/version)
    #[serde(skip)]
    pub os: Option<String>,
}

impl Default for Backend {
    fn default() -> Self {
        Self::new_local("Local")
    }
}

impl Backend {
    /// Create a new local backend with default settings
    pub fn new_local(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            is_local: true,
            host: "127.0.0.1".to_string(),
            port: 51900,
            username: None,
            password: None,
            oauth_port: Some(51901),
            config_password: None,
            config_path: None,
            version: None,
            os: None,
        }
    }

    /// Create a new remote backend
    pub fn new_remote(name: impl Into<String>, host: impl Into<String>, port: u16) -> Self {
        Self {
            name: name.into(),
            is_local: false,
            host: host.into(),
            port,
            username: None,
            password: None,
            oauth_port: None,
            config_password: None,
            config_path: None,
            version: None,
            os: None,
        }
    }

    /// Get the full API URL for this backend
    pub fn api_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// Get the OAuth HTTP URL for this backend (if oauth_port is configured)
    pub fn oauth_url(&self) -> Option<String> {
        self.oauth_port
            .map(|port| format!("http://{}:{}", self.host, port))
    }

    /// Get the OAuth address (host:port) for TCP connection checks
    pub fn oauth_addr(&self) -> Option<String> {
        self.oauth_port
            .map(|port| format!("{}:{}", self.host, port))
    }

    /// Check if RC API auth is properly configured
    ///
    /// Returns true only if BOTH username and password are non-empty.
    pub fn has_valid_auth(&self) -> bool {
        self.username.as_ref().is_some_and(|u| !u.is_empty())
            && self.password.as_ref().is_some_and(|p| !p.is_empty())
    }

    /// Inject Basic Authentication headers into a request builder
    pub fn inject_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.has_valid_auth() {
            let username = self.username.as_ref().unwrap();
            let password = self.password.as_ref().unwrap();
            return builder.basic_auth(username, Some(password));
        }
        builder
    }

    /// Build a full URL for a specific endpoint
    pub fn url_for(&self, endpoint: &str) -> String {
        format!("{}/{}", self.api_url().trim_end_matches('/'), endpoint)
    }

    /// Build a full URL for a specific endpoint using the OAuth port
    pub fn oauth_url_for(&self, endpoint: &str) -> Option<String> {
        self.oauth_url()
            .map(|base| format!("{}/{}", base.trim_end_matches('/'), endpoint))
    }
    /// Make an authenticated request to a specific endpoint
    pub async fn make_request(
        &self,
        client: &reqwest::Client,
        method: reqwest::Method,
        endpoint: &str,
        payload: Option<&serde_json::Value>,
        timeout: Option<std::time::Duration>,
    ) -> Result<reqwest::Response, String> {
        let url = self.url_for(endpoint);
        let mut builder = self.inject_auth(client.request(method, &url));

        if let Some(data) = payload {
            builder = builder.json(data);
        }

        if let Some(duration) = timeout {
            builder = builder.timeout(duration);
        }

        let response = builder
            .send()
            .await
            .map_err(|e| format!("Failed to send request to {}: {}", endpoint, e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            // Try to extract error message from JSON if possible
            let error_msg = if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                json.get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or(body)
            } else {
                body
            };

            return Err(format!("Request failed (HTTP {}): {}", status, error_msg));
        }

        Ok(response)
    }

    /// Helper for POST requests expecting JSON response
    ///
    /// This handles:
    /// 1. URL construction
    /// 2. Authentication injection
    /// 3. Request sending
    /// 4. Error status checking (extracting error message)
    /// 5. JSON response parsing
    pub async fn fetch_runtime_info(
        &self,
        client: &reqwest::Client,
        timeout: std::time::Duration,
    ) -> crate::rclone::backend::runtime::RuntimeInfo {
        use crate::rclone::backend::runtime::RuntimeInfo;
        use crate::rclone::queries::system::{fetch_config_path, fetch_version_info};

        let mut info = RuntimeInfo::new();

        // Fetch core/version with timeout
        let version_future = fetch_version_info(self, client);
        match tokio::time::timeout(timeout, version_future).await {
            Ok(Ok(version_data)) => {
                log::debug!("Fetched version info for backend: {}", self.name);
                info.version = Some(version_data.version);
                info.os = Some(version_data.os);
                info.arch = Some(version_data.arch);
                info.go_version = Some(version_data.go_version);
            }
            Ok(Err(e)) => {
                log::warn!("Failed to fetch version for backend {}: {}", self.name, e);
                return RuntimeInfo::with_error(e);
            }
            Err(_) => {
                log::warn!("Timeout fetching version for backend {}", self.name);
                return RuntimeInfo::with_error("Connection timed out");
            }
        }

        // Fetch config/paths (optional)
        let paths_future = fetch_config_path(self, client);
        match tokio::time::timeout(timeout, paths_future).await {
            Ok(Ok(path)) => {
                log::debug!("Fetched config path for backend: {}", self.name);
                info.config_path = Some(path);
            }
            Ok(Err(e)) => {
                log::debug!(
                    "Could not fetch paths for backend {} (non-critical): {}",
                    self.name,
                    e
                );
            }
            Err(_) => {
                log::debug!(
                    "Timeout fetching paths for backend {} (non-critical)",
                    self.name
                );
            }
        }

        info.set_status("connected");
        info
    }

    /// Helper for POST requests expecting JSON response
    pub async fn post_json(
        &self,
        client: &reqwest::Client,
        endpoint: &str,
        payload: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let response = self
            .make_request(client, reqwest::Method::POST, endpoint, payload, None)
            .await?;

        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))
    }
}

/// Frontend-friendly backend info (for list display)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub name: String,
    pub is_local: bool,
    pub host: String,
    pub port: u16,
    pub is_active: bool,
    pub has_auth: bool,
    pub has_config_password: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_port: Option<u16>,
    // Include auth fields for edit form
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    // Include password for edit form (NOTE: Only sent to frontend, never stored in JSON)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    /// Connection status: "connected", "error:message", or empty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Actual config path being used by rclone (fetched at runtime)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config_path: Option<String>,
}

impl BackendInfo {
    pub fn from_backend(backend: &Backend, is_active: bool) -> Self {
        Self {
            name: backend.name.clone(),
            is_local: backend.is_local,
            host: backend.host.clone(),
            port: backend.port,
            is_active,
            has_auth: backend.has_valid_auth(),
            has_config_password: backend.config_password.is_some(),
            config_path: backend.config_path.clone(),
            oauth_port: backend.oauth_port,
            username: backend.username.clone(),
            password: backend.password.clone(),
            version: None,             // Set from runtime cache
            os: None,                  // Set from runtime cache
            status: None,              // Set from runtime cache
            runtime_config_path: None, // Set from runtime cache
        }
    }

    /// Merge runtime info (version, os, status, runtime_config_path) into BackendInfo
    pub fn with_runtime_info(
        mut self,
        version: Option<String>,
        os: Option<String>,
        status: Option<String>,
        runtime_config_path: Option<String>,
    ) -> Self {
        self.version = version;
        self.os = os;
        self.status = status;
        self.runtime_config_path = runtime_config_path;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_local_backend() {
        let backend = Backend::new_local("Local");

        assert_eq!(backend.name, "Local");
        assert!(backend.is_local);
        assert_eq!(backend.host, "127.0.0.1");
        assert_eq!(backend.port, 51900);
        assert_eq!(backend.oauth_port, Some(51901));
    }

    #[test]
    fn test_new_remote_backend() {
        let backend = Backend::new_remote("NAS", "192.168.1.100", 51900);

        assert_eq!(backend.name, "NAS");
        assert!(!backend.is_local);
        assert_eq!(backend.host, "192.168.1.100");
        assert_eq!(backend.port, 51900);
        assert!(backend.oauth_port.is_none());
    }

    #[test]
    fn test_api_url() {
        let local = Backend::new_local("Local");
        assert_eq!(local.api_url(), "http://127.0.0.1:51900");

        let remote = Backend::new_remote("NAS", "192.168.1.50", 8080);
        assert_eq!(remote.api_url(), "http://192.168.1.50:8080");
    }

    #[test]
    fn test_has_valid_auth() {
        let mut backend = Backend::new_local("Test");
        assert!(!backend.has_valid_auth());

        backend.username = Some("user".to_string());
        assert!(!backend.has_valid_auth()); // password missing

        backend.password = Some("".to_string());
        assert!(!backend.has_valid_auth()); // password empty

        backend.password = Some("pass".to_string());
        assert!(backend.has_valid_auth()); // both set
    }

    #[test]
    fn test_serialization() {
        let backend = Backend::new_local("Local");
        let json = serde_json::to_string(&backend).unwrap();

        // name and password are skipped
        assert!(!json.contains("\"name\""));
        assert!(!json.contains("\"password\""));
        assert!(json.contains("\"is_local\":true"));
        assert!(json.contains("\"host\":\"127.0.0.1\""));
    }

    #[test]
    fn test_deserialization() {
        let json = r#"{
            "is_local": false,
            "host": "10.0.0.1",
            "port": 51900
        }"#;

        let backend: Backend = serde_json::from_str(json).unwrap();
        assert_eq!(backend.name, ""); // skipped, set from key
        assert!(!backend.is_local);
        assert_eq!(backend.host, "10.0.0.1");
    }
}
