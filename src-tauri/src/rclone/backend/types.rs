// Backend types for rclone manager
//
// Simplified flat structure - no nested types.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

fn default_oauth_port() -> u16 {
    51901
}

fn default_oauth_host() -> String {
    "127.0.0.1".to_string()
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

    /// Host address rclone binds to (e.g., "127.0.0.1", "0.0.0.0").
    ///
    /// Note: wildcard addresses like `0.0.0.0` or `::` cannot be used for
    /// outgoing HTTP requests. Use [`Backend::request_host`] to get a
    /// routable address for connections.
    pub host: String,

    /// RC API port (e.g., 51900)
    pub port: u16,

    /// RC API username (for --rc-user)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,

    /// RC API password (for --rc-pass) - stored in keychain, not JSON
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,

    /// Port for the OAuth helper process.
    ///
    /// Always required — there is no valid configuration without an OAuth
    /// port for local backends, and we keep a consistent default for remote
    /// ones so the field is never absent.
    #[serde(default = "default_oauth_port")]
    pub oauth_port: u16,

    /// Host the OAuth helper process listens on / that we connect to.
    ///
    /// Defaults to `127.0.0.1`. Must be a routable address (never a wildcard
    /// like `0.0.0.0`), because we make outgoing HTTP requests to it.
    /// In Docker environments set this to the container's accessible address.
    #[serde(default = "default_oauth_host")]
    pub oauth_host: String,

    /// Config password for encrypted remote configs - stored in keychain
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_password: Option<String>,

    /// Config file path (for remote backends mostly) - optional
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<PathBuf>,
}

impl Default for Backend {
    fn default() -> Self {
        Self::new_local(default_backend_name())
    }
}

pub fn default_backend_name() -> String {
    "Local".to_string()
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
            oauth_port: 51901,
            oauth_host: "127.0.0.1".to_string(),
            config_password: None,
            config_path: None,
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
            oauth_port: default_oauth_port(),
            oauth_host: default_oauth_host(),
            config_password: None,
            config_path: None,
        }
    }

    /// Resolve the host to a routable address for outgoing HTTP requests.
    ///
    /// Wildcard bind addresses (`0.0.0.0`, `::`) cannot be used as request
    /// targets. This maps them to their loopback equivalents so we can
    /// always connect to a locally-bound rclone process regardless of how
    /// the user configured the bind address.
    pub fn request_host(&self) -> &str {
        match self.host.as_str() {
            "0.0.0.0" => "127.0.0.1",
            "::" | "::0" => "::1",
            h => h,
        }
    }

    /// Format a host string for use in HTTP URLs.
    ///
    /// IPv6 addresses must be wrapped in brackets per RFC 3986.
    fn format_url_host(host: &str) -> String {
        if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_string()
        }
    }

    /// Get the full API URL for this backend
    pub fn api_url(&self) -> String {
        let host = Self::format_url_host(self.request_host());
        format!("http://{host}:{}", self.port)
    }

    /// Get the OAuth HTTP URL for this backend
    pub fn oauth_url(&self) -> String {
        let host = Self::format_url_host(&self.oauth_host);
        format!("http://{host}:{}", self.oauth_port)
    }

    /// Get the OAuth address (host:port) for TCP connection checks.
    ///
    /// Rust's `TcpStream::connect` requires brackets for IPv6 addresses.
    pub fn oauth_addr(&self) -> String {
        let host = Self::format_url_host(&self.oauth_host);
        format!("{host}:{}", self.oauth_port)
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
            builder.basic_auth(
                self.username.as_deref().unwrap_or_default(),
                self.password.as_deref(),
            )
        } else {
            builder
        }
    }

    /// Build a full URL for a specific endpoint
    pub fn url_for(&self, endpoint: &str) -> String {
        format!("{}/{endpoint}", self.api_url().trim_end_matches('/'))
    }

    /// Build a full URL for a specific endpoint using the OAuth port
    pub fn oauth_url_for(&self, endpoint: &str) -> String {
        format!("{}/{endpoint}", self.oauth_url().trim_end_matches('/'))
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
            .map_err(|e| format!("Failed to send request to {endpoint}: {e}"))?;

        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let error_msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|json| {
                json.get("error")
                    .and_then(|e| e.as_str())
                    .map(str::to_string)
            })
            .unwrap_or(body);

        Err(format!("Request failed (HTTP {status}): {error_msg}"))
    }

    /// Fetch runtime version and config-path information from the rclone API.
    pub async fn fetch_runtime_info(
        &self,
        client: &reqwest::Client,
        timeout: std::time::Duration,
    ) -> crate::rclone::backend::runtime::RuntimeInfo {
        use crate::rclone::backend::runtime::RuntimeInfo;
        use crate::rclone::queries::system::fetch_version_info;

        let mut info = RuntimeInfo::new();

        match tokio::time::timeout(timeout, fetch_version_info(self, client)).await {
            Ok(Ok(version_data)) => {
                log::debug!("Fetched version info for backend: {}", self.name);
                info.version = Some(version_data.version);
                info.os = Some(version_data.os);
                info.arch = Some(version_data.arch);
                info.go_version = Some(version_data.go_version);
            }
            Ok(Err(e)) => {
                log::warn!("Failed to fetch version for backend {}: {e}", self.name);
                return RuntimeInfo::with_error(e);
            }
            Err(_) => {
                log::warn!("Timeout fetching version for backend {}", self.name);
                return RuntimeInfo::with_error("Connection timed out");
            }
        }

        // Config path is non-critical — log and continue on failure.
        match tokio::time::timeout(timeout, self.fetch_config_path(client)).await {
            Ok(Ok(path)) => {
                log::debug!("Fetched config path for backend: {}", self.name);
                info.config_path = Some(path);
            }
            Ok(Err(e)) => {
                log::debug!(
                    "Could not fetch config path for backend {} (non-critical): {e}",
                    self.name
                );
            }
            Err(_) => {
                log::debug!(
                    "Timeout fetching config path for backend {} (non-critical)",
                    self.name
                );
            }
        }

        info.set_status("connected");
        info
    }

    /// Build the URL used to fetch a remote file over the rclone serve endpoint.
    fn build_file_url(&self, remote: &str, path: &str) -> String {
        let r_name = if remote.contains(':') {
            remote.to_string()
        } else {
            format!("{remote}:")
        };

        let encoded_path = path
            .split('/')
            .map(urlencoding::encode)
            .collect::<Vec<_>>()
            .join("/");

        format!(
            "{}/[{r_name}]/{}",
            self.api_url().trim_end_matches('/'),
            encoded_path.trim_start_matches('/')
        )
    }

    /// Helper to construct URL and fetch a remote file stream with authentication.
    pub async fn fetch_file_stream(
        &self,
        client: &reqwest::Client,
        remote: &str,
        path: &str,
    ) -> Result<reqwest::Response, String> {
        self.fetch_file_stream_with_range(client, remote, path, None)
            .await
    }

    /// Like [`fetch_file_stream`] but forwards an optional HTTP `Range` header.
    ///
    /// The custom URI protocol handler uses this to forward browser range
    /// requests unchanged, allowing rclone to return partial content and avoid
    /// buffering large blobs in memory.
    pub async fn fetch_file_stream_with_range(
        &self,
        client: &reqwest::Client,
        remote: &str,
        path: &str,
        range: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let url = self.build_file_url(remote, path);
        let mut builder = self.inject_auth(client.get(&url));

        if let Some(r) = range {
            builder = builder.header(reqwest::header::RANGE, r);
        }

        builder
            .send()
            .await
            .map_err(|e| format!("Failed to fetch remote file: {e}"))
    }

    /// Helper for POST requests expecting a JSON response.
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
            .map_err(|e| format!("Failed to parse response: {e}"))
    }

    /// Internal helper to fetch the config path from this backend's RC API.
    async fn fetch_config_path(&self, client: &reqwest::Client) -> Result<PathBuf, String> {
        use crate::utils::rclone::endpoints::config;
        let paths = self
            .post_json(client, config::PATHS, Some(&serde_json::json!({})))
            .await?;

        let config_path = paths
            .get("config")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "No config path in response".to_string())?;

        Ok(PathBuf::from(config_path))
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
    pub config_path: Option<PathBuf>,
    pub oauth_port: u16,
    pub oauth_host: String,
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
    pub runtime_config_path: Option<PathBuf>,
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
            oauth_host: backend.oauth_host.clone(),
            username: backend.username.clone(),
            password: backend.password.clone(),
            version: None,
            os: None,
            status: None,
            runtime_config_path: None,
        }
    }

    /// Merge runtime info (version, os, status, runtime_config_path) into BackendInfo
    pub fn with_runtime_info(
        mut self,
        version: Option<String>,
        os: Option<String>,
        status: Option<String>,
        runtime_config_path: Option<PathBuf>,
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
        assert_eq!(backend.oauth_port, 51901);
        assert_eq!(backend.oauth_host, "127.0.0.1");
    }

    #[test]
    fn test_new_remote_backend() {
        let backend = Backend::new_remote("NAS", "192.168.1.100", 51900);

        assert_eq!(backend.name, "NAS");
        assert!(!backend.is_local);
        assert_eq!(backend.host, "192.168.1.100");
        assert_eq!(backend.port, 51900);
        assert_eq!(backend.oauth_port, 51901);
    }

    #[test]
    fn test_api_url() {
        let local = Backend::new_local("Local");
        assert_eq!(local.api_url(), "http://127.0.0.1:51900");

        let remote = Backend::new_remote("NAS", "192.168.1.50", 8080);
        assert_eq!(remote.api_url(), "http://192.168.1.50:8080");
    }

    #[test]
    fn test_request_host_wildcard_resolution() {
        let mut b = Backend::new_local("test");

        b.host = "0.0.0.0".to_string();
        assert_eq!(b.request_host(), "127.0.0.1");
        assert_eq!(b.api_url(), "http://127.0.0.1:51900");

        b.host = "::".to_string();
        assert_eq!(b.request_host(), "::1");
        assert_eq!(b.api_url(), "http://[::1]:51900");

        b.host = "192.168.1.10".to_string();
        assert_eq!(b.request_host(), "192.168.1.10");
        assert_eq!(b.api_url(), "http://192.168.1.10:51900");
    }

    #[test]
    fn test_ipv6_url_formatting() {
        let mut b = Backend::new_local("test");
        b.host = "::1".to_string();
        assert_eq!(b.api_url(), "http://[::1]:51900");

        b.oauth_host = "::1".to_string();
        assert_eq!(b.oauth_url(), "http://[::1]:51901");
        assert_eq!(b.oauth_addr(), "[::1]:51901");
    }

    #[test]
    fn test_oauth_url() {
        let backend = Backend::new_local("Local");
        assert_eq!(backend.oauth_url(), "http://127.0.0.1:51901");
        assert_eq!(backend.oauth_addr(), "127.0.0.1:51901");
        assert_eq!(
            backend.oauth_url_for("core/quit"),
            "http://127.0.0.1:51901/core/quit"
        );
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
        assert!(backend.has_valid_auth());
    }

    #[test]
    fn test_serialization() {
        let backend = Backend::new_local("Local");
        let json = serde_json::to_string(&backend).unwrap();

        // name is skipped, password is None so also skipped
        assert!(!json.contains("\"name\""));
        assert!(json.contains("\"is_local\":true"));
        assert!(json.contains("\"host\":\"127.0.0.1\""));
        assert!(json.contains("\"oauth_port\":51901"));
        assert!(json.contains("\"oauth_host\":\"127.0.0.1\""));
    }

    #[test]
    fn test_deserialization_backward_compat() {
        // Old configs without oauth_port or oauth_host should deserialize with defaults.
        let json = r#"{
            "is_local": false,
            "host": "10.0.0.1",
            "port": 51900
        }"#;

        let backend: Backend = serde_json::from_str(json).unwrap();
        assert_eq!(backend.name, ""); // skipped, set from key
        assert!(!backend.is_local);
        assert_eq!(backend.host, "10.0.0.1");
        assert_eq!(backend.oauth_port, 51901); // default
        assert_eq!(backend.oauth_host, "127.0.0.1"); // default
    }
}
