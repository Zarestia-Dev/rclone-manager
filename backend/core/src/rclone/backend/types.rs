use std::path::PathBuf;

use rcman::DeriveSettingsSchema;
use serde::{Deserialize, Serialize};

use crate::rclone::backend::BackendError;
use crate::rclone::backend::runtime::RuntimeInfo;
use crate::rclone::endpoints::config;
use crate::rclone::endpoints::core;
use crate::rclone::engine::core::DEFAULT_API_PORT;

/// Single flat backend configuration
///
/// Represents a connection to an rclone RC API server.
/// - Local: Managed by the app (starts/stops the process)
/// - Remote: External rclone rcd instance
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct Backend {
    /// Unique name/identifier (used as key, skipped in serialization)
    #[serde(skip)]
    pub name: String,

    /// True = managed by app (Local), False = external (Remote)
    #[serde(default)]
    pub is_local: bool,

    /// True = authentication credentials were auto-generated at runtime and should not be saved to disk
    #[serde(skip)]
    pub is_auth_generated: bool,

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
    #[setting(secret)]
    pub password: Option<String>,

    /// Config password for encrypted remote configs - stored in keychain
    #[serde(skip_serializing_if = "Option::is_none")]
    #[setting(secret)]
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

use crate::utils::constants::LOCAL_BACKEND_NAME;

pub fn default_backend_name() -> String {
    LOCAL_BACKEND_NAME.to_string()
}

impl Backend {
    #[must_use]
    pub fn is_local_name(name: &str) -> bool {
        name == LOCAL_BACKEND_NAME
    }

    #[must_use]
    pub fn profile_name_for(name: &str) -> &str {
        if Self::is_local_name(name) {
            crate::utils::constants::LOCAL_BACKEND_PROFILE
        } else {
            name
        }
    }

    /// Check if this backend uses in-process librclone (local backend + librclone feature enabled)
    #[must_use]
    pub fn is_librclone_local(&self) -> bool {
        cfg!(feature = "librclone") && self.is_local
    }
}

impl Backend {
    /// Create a new local backend with default settings
    pub fn new_local(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            is_local: true,
            is_auth_generated: false,
            host: "127.0.0.1".to_string(),
            port: DEFAULT_API_PORT,
            username: None,
            password: None,
            config_password: None,
            config_path: None,
        }
    }

    /// Create a new remote backend
    pub fn new_remote(name: impl Into<String>, host: impl Into<String>, port: u16) -> Self {
        Self {
            name: name.into(),
            is_local: false,
            is_auth_generated: false,
            host: host.into(),
            port,
            username: None,
            password: None,
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

    /// Make an authenticated request to a specific endpoint
    pub async fn make_request(
        &self,
        client: &reqwest::Client,
        method: reqwest::Method,
        endpoint: &str,
        payload: Option<&serde_json::Value>,
        timeout: Option<std::time::Duration>,
    ) -> Result<reqwest::Response, BackendError> {
        let url = self.url_for(endpoint);
        let mut builder = self.inject_auth(client.request(method, &url));

        if let Some(data) = payload {
            builder = builder.json(data);
        }
        if let Some(duration) = timeout {
            builder = builder.timeout(duration);
        }

        let response = builder.send().await.map_err(|e| {
            BackendError::NotConnected(format!("Failed to send request to {endpoint}: {e}"))
        })?;

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

        Err(BackendError::Rpc {
            endpoint: endpoint.to_string(),
            status: status.as_u16(),
            message: error_msg,
        })
    }

    pub async fn fetch_runtime_info(
        &self,
        transport: &dyn crate::rclone::backend::RcloneTransport,
        timeout: std::time::Duration,
    ) -> crate::rclone::backend::runtime::RuntimeInfo {
        let use_http = !self.is_local || !cfg!(feature = "librclone");
        let client = reqwest::Client::new();

        let version_fut = async {
            let res = if use_http {
                self.post_json_with_timeout(&client, core::VERSION, None, timeout)
                    .await
            } else {
                transport
                    .rpc_with_timeout(core::VERSION, None, timeout)
                    .await
                    .map_err(|e| e.to_string())
            };

            match res {
                Ok(json) => {
                    serde_json::from_value::<crate::utils::types::rclone::RcloneCoreVersion>(json)
                        .map_err(|e| format!("Failed to parse version: {e}"))
                }
                Err(e) => Err(format!("Failed to fetch version: {e}")),
            }
        };

        let pid_fut = async {
            let res = if use_http {
                self.post_json_with_timeout(&client, core::PID, None, timeout)
                    .await
            } else {
                transport
                    .rpc_with_timeout(core::PID, None, timeout)
                    .await
                    .map_err(|e| e.to_string())
            };

            match res {
                Ok(json) => json
                    .get("pid")
                    .and_then(serde_json::Value::as_u64)
                    .map(|v| v as u32),
                _ => None,
            }
        };

        let config_path_fut = async {
            let res = if use_http {
                tokio::time::timeout(timeout, self.fetch_config_path_http(&client))
                    .await
                    .map_err(|_| "Connection timed out".to_string())
                    .and_then(|r| r)
            } else {
                transport
                    .rpc_with_timeout(config::PATHS, Some(&serde_json::json!({})), timeout)
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|paths| {
                        paths
                            .get("config")
                            .and_then(|v| v.as_str())
                            .map(PathBuf::from)
                            .ok_or_else(|| "No config path in response".to_string())
                    })
            };

            res.ok()
        };

        let (version_res, pid, config_path) = tokio::join!(version_fut, pid_fut, config_path_fut);

        match version_res {
            Ok(version_data) => RuntimeInfo {
                version: Some(version_data.version.clone()),
                os: Some(version_data.os.clone()),
                arch: Some(version_data.arch.clone()),
                go_version: Some(version_data.go_version.clone()),
                core_version: Some(version_data),
                pid,
                config_path,
                status: crate::rclone::backend::runtime::RuntimeStatus::Connected,
            },
            Err(e) => {
                log::warn!("Failed to fetch version for backend {}: {e}", self.name);
                RuntimeInfo::with_error(e)
            }
        }
    }

    /// Build the URL used to fetch a remote file over the rclone serve endpoint.
    fn build_file_url(&self, remote: &str, path: &str) -> String {
        let (remote, path) = crate::utils::io::file_stream::file_location(remote, path);
        let r_name = if remote.contains(':')
            || remote.contains('/')
            || remote.contains('\\')
            || remote == "."
        {
            remote.to_string()
        } else {
            format!("{remote}:")
        };
        let r_name = urlencoding::encode(&r_name);

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

    /// Helper to construct URL and fetch a remote file stream with authentication,
    /// forwarding an optional HTTP `Range` header.
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
        // Byte offsets refer to the original representation, not compressed data.
        let mut builder = self
            .inject_auth(client.get(&url))
            .header(reqwest::header::ACCEPT_ENCODING, "identity");

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
            .await
            .map_err(|e| e.to_string())?;

        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {e}"))
    }

    pub async fn post_json_with_timeout(
        &self,
        client: &reqwest::Client,
        endpoint: &str,
        payload: Option<&serde_json::Value>,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        let response = self
            .make_request(
                client,
                reqwest::Method::POST,
                endpoint,
                payload,
                Some(timeout),
            )
            .await
            .map_err(|e| e.to_string())?;

        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {e}"))
    }

    /// Internal helper to fetch the config path directly over HTTP.
    async fn fetch_config_path_http(&self, client: &reqwest::Client) -> Result<PathBuf, String> {
        let paths = self
            .post_json(client, config::PATHS, Some(&serde_json::json!({})))
            .await?;

        let config_path = paths
            .get("config")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "No config path in response".to_string())?;

        Ok(PathBuf::from(config_path))
    }

    /// Build a payload for the `core/command` RC endpoint.
    ///
    /// This automatically:
    /// 1. Disables interactive password prompts (`--ask-password=false`).
    /// 2. Injects the configuration password via `--password-command` if available.
    pub fn build_core_command_payload(
        &self,
        command: &str,
        mut args: Vec<String>,
        async_job: bool,
        os: Option<String>,
    ) -> serde_json::Value {
        args.push("--ask-password=false".to_string());

        if let Some(config_path) = &self.config_path
            && let Some(path_str) = config_path.to_str()
        {
            args.push(format!("--config={path_str}"));
        }

        if let Some(pass) = &self.config_password {
            let is_windows = os
                .as_ref()
                .is_some_and(|os| os.to_lowercase().contains("windows"));

            if is_windows {
                use base64::{Engine as _, engine::general_purpose::STANDARD};
                let base64_pass = STANDARD.encode(pass);
                args.push(format!(
                    "--password-command=powershell -NoProfile -Command \"[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{base64_pass}')))\""
                ));
            } else {
                let mut octal_pass = String::new();
                for byte in pass.as_bytes() {
                    octal_pass.push_str(&format!("\\{:03o}", byte));
                }
                args.push(format!(
                    "--password-command=sh -c \"printf '{octal_pass}'\""
                ));
            }
        }

        let mut payload = serde_json::json!({
            "command": command,
            "arg": args,
        });

        if async_job {
            payload["_async"] = serde_json::json!(true);
        }

        payload
    }
}

/// Frontend-friendly backend info (for list display)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub name: String,
    pub is_local: bool,
    pub is_auth_generated: bool,
    pub host: String,
    pub port: u16,
    pub is_active: bool,
    pub has_auth: bool,
    pub has_config_password: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    /// Connection status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<crate::rclone::backend::runtime::RuntimeStatus>,
    /// Actual config path being used by rclone (fetched at runtime)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config_path: Option<PathBuf>,
}

impl BackendInfo {
    pub fn from_backend(backend: &Backend, is_active: bool) -> Self {
        Self {
            name: backend.name.clone(),
            is_local: backend.is_local,
            is_auth_generated: backend.is_auth_generated,
            host: backend.host.clone(),
            port: backend.port,
            is_active,
            has_auth: backend.has_valid_auth(),
            has_config_password: backend.config_password.is_some(),
            config_path: backend.config_path.clone(),
            username: backend.username.clone(),
            password: backend.password.clone(),
            version: None,
            os: None,
            status: None,
            runtime_config_path: None,
        }
    }

    /// Merge runtime info (version, os, status, `runtime_config_path`) into `BackendInfo`
    pub fn with_runtime_info(
        mut self,
        version: Option<String>,
        os: Option<String>,
        status: Option<crate::rclone::backend::runtime::RuntimeStatus>,
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

    #[tokio::test]
    async fn ranged_file_requests_preserve_original_byte_offsets() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let request = crate::utils::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                assert_ne!(socket.read_buf(&mut headers).await.unwrap(), 0);
                assert!(headers.len() < 8192);
            }
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 10-12/20\r\nConnection: close\r\n\r\nabc").await.unwrap();
            String::from_utf8(headers).unwrap().to_lowercase()
        });
        let backend = Backend::new_remote("test", "127.0.0.1", port);
        let response = backend
            .fetch_file_stream_with_range(
                &reqwest::Client::new(),
                "drive:",
                "song.mp3",
                Some("bytes=10-12"),
            )
            .await
            .unwrap();
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"abc");
        let headers = request.await.unwrap();
        assert!(headers.contains("accept-encoding: identity\r\n"));
        assert!(headers.contains("range: bytes=10-12\r\n"));
    }

    #[tokio::test]
    async fn http_requests_preserve_status_and_error_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for (status, body, expected) in [
            (200, "{}", None),
            (
                401,
                r#"{"error":"credentials rejected"}"#,
                Some("credentials rejected"),
            ),
            (403, "", Some("")),
            (
                500,
                "upstream mentioned HTTP 401",
                Some("upstream mentioned HTTP 401"),
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let backend =
                Backend::new_remote("test", "127.0.0.1", listener.local_addr().unwrap().port());
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let serve = async {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let byte = stream.read_u8().await.unwrap();
                    request.push(byte);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            };
            let request =
                backend.make_request(&client, reqwest::Method::POST, core::VERSION, None, None);
            let (_, result) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                tokio::join!(serve, request)
            })
            .await
            .unwrap();
            if let Some(expected) = expected {
                match result.unwrap_err() {
                    BackendError::Rpc {
                        endpoint,
                        status: actual,
                        message,
                    } => {
                        assert_eq!(endpoint, core::VERSION);
                        assert_eq!(actual, status);
                        assert_eq!(message, expected);
                    }
                    other => panic!("expected RPC error, got {other:?}"),
                }
            } else {
                assert_eq!(result.unwrap().status().as_u16(), status);
            }
        }
    }

    #[tokio::test]
    async fn http_send_failure_is_a_transport_error() {
        // An invalid URL rejects the request before any network connection.
        let backend = Backend::new_remote("test", "[invalid", 51900);
        let error = backend
            .make_request(
                &reqwest::Client::new(),
                reqwest::Method::POST,
                core::VERSION,
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, BackendError::NotConnected(_)));
    }

    #[test]
    fn test_new_local_backend() {
        let backend = Backend::new_local("Local");

        assert_eq!(backend.name, "Local");
        assert!(backend.is_local);
        assert_eq!(backend.host, "127.0.0.1");
        assert_eq!(backend.port, 51900);
    }

    #[test]
    fn test_new_remote_backend() {
        let backend = Backend::new_remote("NAS", "192.168.1.100", 51900);

        assert_eq!(backend.name, "NAS");
        assert!(!backend.is_local);
        assert_eq!(backend.host, "192.168.1.100");
        assert_eq!(backend.port, 51900);
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

        assert!(!json.contains("\"name\""));
        assert!(json.contains("\"is_local\":true"));
        assert!(json.contains("\"host\":\"127.0.0.1\""));
    }

    #[test]
    fn test_deserialization_backward_compat() {
        let json = r#"{
            "is_local": false,
            "host": "10.0.0.1",
            "port": 51900
        }"#;

        let backend: Backend = serde_json::from_str(json).unwrap();
        assert_eq!(backend.name, "");
        assert!(!backend.is_local);
        assert_eq!(backend.host, "10.0.0.1");
    }

    #[test]
    fn test_is_auth_generated_default() {
        let backend = Backend::new_local("Local");
        assert!(!backend.is_auth_generated);
    }

    #[test]
    fn file_urls_preserve_local_roots_and_reserved_remote_characters() {
        let backend = Backend::new_remote("test", "localhost", 1234);
        assert_eq!(
            backend.build_file_url("", "/music/a #+.mp3"),
            "http://localhost:1234/[%2Fmusic%2F]/a%20%23%2B.mp3"
        );
        assert_eq!(
            backend.build_file_url("drive #+%:", "folder/a.mp3"),
            "http://localhost:1234/[drive%20%23%2B%25%3A]/folder/a.mp3"
        );
    }
}
