// Backend types for multi-backend architecture
//
// These types represent rclone backends (local and remote)
// and their connection configurations.

use crate::utils::types::all_types::{JobCache, RemoteCache};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Represents a single rclone backend instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RcloneBackend {
    /// Unique identifier and display name (like rclone remotes)
    /// Note: This is skipped in serialization as it's used as the HashMap key
    #[serde(skip)]
    pub name: String,
    /// Type of backend (local or remote)
    pub backend_type: BackendType,
    /// Connection configuration
    pub connection: BackendConnection,
    /// OAuth configuration (only for Local backends)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthConfig>,
    /// Per-backend remote cache
    #[serde(skip, default = "default_remote_cache")]
    pub remote_cache: Arc<RemoteCache>,
    /// Per-backend job cache
    #[serde(skip, default = "default_job_cache")]
    pub job_cache: Arc<JobCache>,
    /// Current connection status (not persisted)
    #[serde(skip)]
    pub status: BackendStatus,
    /// Config password for the backend
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_password: Option<String>,
}

fn default_remote_cache() -> Arc<RemoteCache> {
    Arc::new(RemoteCache::new())
}

fn default_job_cache() -> Arc<JobCache> {
    Arc::new(JobCache::new())
}

/// Type of rclone backend
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BackendType {
    /// Managed by the app (start/stop process, OAuth)
    #[default]
    Local,
    /// External rclone rcd instance
    Remote,
}

/// Backend connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendConnection {
    /// Host address (e.g., "127.0.0.1")
    pub host: String,
    /// Port number (e.g., 51900)
    pub port: u16,
    /// Optional authentication credentials
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<BackendAuth>,
    /// Whether the rclone config is encrypted
    #[serde(default)]
    pub config_encrypted: bool,
    // Note: config_password stored separately via rcman .secret()
}

/// OAuth configuration for local backends
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthConfig {
    /// OAuth host (usually "127.0.0.1")
    pub host: String,
    /// OAuth port (e.g., 51901)
    pub port: u16,
    // Uses same auth as BackendConnection.auth
}

/// Authentication credentials for backend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendAuth {
    /// Username for --rc-user
    pub username: String,
    /// Password for --rc-pass
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// Current connection status of a backend
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum BackendStatus {
    /// Successfully connected
    Connected,
    /// Not connected
    #[default]
    Disconnected,
    /// Currently attempting connection
    #[allow(dead_code)]
    Connecting,
    /// Connection error occurred
    #[allow(dead_code)]
    Error(String),
}

/// Frontend-friendly backend information
#[derive(Debug, Clone, Serialize)]
pub struct BackendInfo {
    pub name: String,
    pub backend_type: BackendType,
    pub host: String,
    pub port: u16,
    pub is_active: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_port: Option<u16>,
}

impl BackendInfo {
    pub fn from_backend(backend: &RcloneBackend, is_active: bool) -> Self {
        Self {
            name: backend.name.clone(),
            backend_type: backend.backend_type.clone(),
            host: backend.connection.host.clone(),
            port: backend.connection.port,
            is_active,
            status: match &backend.status {
                BackendStatus::Connected => "connected".to_string(),
                BackendStatus::Disconnected => "disconnected".to_string(),
                BackendStatus::Connecting => "connecting".to_string(),
                BackendStatus::Error(e) => format!("error: {}", e),
            },
            username: backend.connection.auth.as_ref().map(|a| a.username.clone()),
            password: backend
                .connection
                .auth
                .as_ref()
                .and_then(|a| a.password.clone()),
            config_password: backend.config_password.clone(),
            oauth_host: backend.oauth.as_ref().map(|o| o.host.clone()),
            oauth_port: backend.oauth.as_ref().map(|o| o.port),
        }
    }
}

impl RcloneBackend {
    /// Create a new local backend with default settings
    pub fn new_local(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            backend_type: BackendType::Local,
            connection: BackendConnection {
                host: "127.0.0.1".to_string(),
                port: 51900,
                auth: None,
                config_encrypted: false,
            },
            oauth: Some(OAuthConfig {
                host: "127.0.0.1".to_string(),
                port: 51901,
            }),
            remote_cache: Arc::new(RemoteCache::new()),
            job_cache: Arc::new(JobCache::new()),
            status: BackendStatus::Disconnected,
            config_password: None,
        }
    }

    /// Create a new remote backend
    pub fn new_remote(name: impl Into<String>, host: impl Into<String>, port: u16) -> Self {
        Self {
            name: name.into(),
            backend_type: BackendType::Remote,
            connection: BackendConnection {
                host: host.into(),
                port,
                auth: None,
                config_encrypted: false,
            },
            oauth: None,
            remote_cache: Arc::new(RemoteCache::new()),
            job_cache: Arc::new(JobCache::new()),
            status: BackendStatus::Disconnected,
            config_password: None,
        }
    }

    /// Get the full API URL for this backend
    pub fn api_url(&self) -> String {
        format!("http://{}:{}", self.connection.host, self.connection.port)
    }

    /// Inject Basic Authentication headers into a request builder if credentials exist
    pub fn inject_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(ref auth) = self.connection.auth {
            // Use password if present, otherwise fall back to username as password
            let password = auth.password.as_deref().unwrap_or(&auth.username);
            return builder.basic_auth(&auth.username, Some(password));
        }
        builder
    }

    /// Get the OAuth URL (only for local backends)
    pub fn oauth_url(&self) -> Option<String> {
        self.oauth
            .as_ref()
            .map(|o| format!("http://{}:{}", o.host, o.port))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_local_backend() {
        let backend = RcloneBackend::new_local("Local");

        assert_eq!(backend.name, "Local");
        assert_eq!(backend.backend_type, BackendType::Local);
        assert_eq!(backend.connection.host, "127.0.0.1");
        assert_eq!(backend.connection.port, 51900);
        assert!(backend.oauth.is_some());
        assert_eq!(backend.oauth.as_ref().unwrap().port, 51901);
        assert_eq!(backend.status, BackendStatus::Disconnected);
    }

    #[test]
    fn test_new_remote_backend() {
        let backend = RcloneBackend::new_remote("NAS", "192.168.1.100", 51900);

        assert_eq!(backend.name, "NAS");
        assert_eq!(backend.backend_type, BackendType::Remote);
        assert_eq!(backend.connection.host, "192.168.1.100");
        assert_eq!(backend.connection.port, 51900);
        assert!(backend.oauth.is_none());
    }

    #[test]
    fn test_api_url() {
        let local = RcloneBackend::new_local("Local");
        assert_eq!(local.api_url(), "http://127.0.0.1:51900");

        let remote = RcloneBackend::new_remote("NAS", "192.168.1.50", 8080);
        assert_eq!(remote.api_url(), "http://192.168.1.50:8080");
    }

    #[test]
    fn test_oauth_url() {
        let local = RcloneBackend::new_local("Local");
        assert_eq!(
            local.oauth_url(),
            Some("http://127.0.0.1:51901".to_string())
        );

        let remote = RcloneBackend::new_remote("NAS", "192.168.1.50", 51900);
        assert_eq!(remote.oauth_url(), None);
    }

    #[test]
    fn test_backend_type_default() {
        let default_type = BackendType::default();
        assert_eq!(default_type, BackendType::Local);
    }

    #[test]
    fn test_backend_status_default() {
        let default_status = BackendStatus::default();
        assert_eq!(default_status, BackendStatus::Disconnected);
    }

    #[test]
    fn test_serialization() {
        let backend = RcloneBackend::new_local("Local");
        let json = serde_json::to_string(&backend).unwrap();

        assert!(json.contains("\"name\":\"Local\""));
        assert!(json.contains("\"backend_type\":\"local\""));
        assert!(json.contains("\"host\":\"127.0.0.1\""));

        // status should be skipped
        assert!(!json.contains("status"));
    }

    #[test]
    fn test_deserialization() {
        let json = r#"{
            "name": "Test",
            "backend_type": "remote",
            "connection": {
                "host": "10.0.0.1",
                "port": 51900
            }
        }"#;

        let backend: RcloneBackend = serde_json::from_str(json).unwrap();
        assert_eq!(backend.name, "Test");
        assert_eq!(backend.backend_type, BackendType::Remote);
        assert_eq!(backend.connection.host, "10.0.0.1");
        assert_eq!(backend.status, BackendStatus::Disconnected); // default
    }
}
