use std::path::PathBuf;

use rcman::DeriveSettingsSchema;
use serde::{Deserialize, Serialize};

use crate::{
    rclone::{backend::runtime::RuntimeInfo, engine::core::DEFAULT_API_PORT},
    utils::rclone::endpoints::{config, core},
};

/// Wrap a future in a per-call timeout, mapping an elapsed deadline to a
/// fixed `"Connection timed out"` error and converting any inner error to
/// `String`.
async fn with_timeout<F, T, E>(timeout: std::time::Duration, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("Connection timed out".to_string()),
    }
}

#[cfg(not(feature = "librclone"))]
fn default_oauth_port() -> u16 {
    use crate::rclone::engine::core::DEFAULT_OAUTH_PORT;
    DEFAULT_OAUTH_PORT
}

#[cfg(not(feature = "librclone"))]
fn default_oauth_host() -> String {
    "127.0.0.1".to_string()
}

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

    /// Port for the OAuth helper process.
    ///
    /// Always required — there is no valid configuration without an OAuth
    /// port for local backends, and we keep a consistent default for remote
    /// ones so the field is never absent.
    #[serde(default = "default_oauth_port")]
    #[cfg(not(feature = "librclone"))]
    pub oauth_port: u16,

    /// Host the OAuth helper process listens on / that we connect to.
    ///
    /// Defaults to `127.0.0.1`. Must be a routable address (never a wildcard
    /// like `0.0.0.0`), because we make outgoing HTTP requests to it.
    /// In Docker environments set this to the container's accessible address.
    #[serde(default = "default_oauth_host")]
    #[cfg(not(feature = "librclone"))]
    pub oauth_host: String,

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

pub fn default_backend_name() -> String {
    "Local".to_string()
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
            #[cfg(not(feature = "librclone"))]
            oauth_port: default_oauth_port(),
            #[cfg(not(feature = "librclone"))]
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
            is_auth_generated: false,
            host: host.into(),
            port,
            username: None,
            password: None,
            #[cfg(not(feature = "librclone"))]
            oauth_port: default_oauth_port(),
            #[cfg(not(feature = "librclone"))]
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
    #[cfg(not(feature = "librclone"))]
    pub fn oauth_url(&self) -> String {
        let host = Self::format_url_host(&self.oauth_host);
        format!("http://{host}:{}", self.oauth_port)
    }

    /// Get the OAuth address (host:port) for TCP connection checks.
    ///
    /// Rust's `TcpStream::connect` requires brackets for IPv6 addresses.
    #[cfg(not(feature = "librclone"))]
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
    #[cfg(not(feature = "librclone"))]
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

    pub async fn fetch_runtime_info(
        &self,
        transport: &dyn crate::rclone::backend::RcloneTransport,
        timeout: std::time::Duration,
    ) -> crate::rclone::backend::runtime::RuntimeInfo {
        let use_http = !self.is_local || !cfg!(feature = "librclone");
        let client = reqwest::Client::new();

        let version_fut = async {
            let res = if use_http {
                with_timeout(timeout, self.post_json(&client, core::VERSION, None)).await
            } else {
                with_timeout(
                    timeout,
                    transport.rpc_with_timeout(core::VERSION, None, timeout),
                )
                .await
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
                with_timeout(timeout, self.post_json(&client, core::PID, None)).await
            } else {
                with_timeout(timeout, transport.rpc(core::PID, None)).await
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
                with_timeout(timeout, self.fetch_config_path_http(&client)).await
            } else {
                with_timeout(timeout, self.fetch_config_path(transport)).await
            };

            res.ok()
        };

        let (version_res, pid, config_path) = tokio::join!(version_fut, pid_fut, config_path_fut);

        match version_res {
            Ok(version_data) => {
                let mut info = RuntimeInfo::new();
                info.version = Some(version_data.version.clone());
                info.os = Some(version_data.os.clone());
                info.arch = Some(version_data.arch.clone());
                info.go_version = Some(version_data.go_version.clone());
                info.core_version = Some(version_data);
                info.pid = pid;
                info.config_path = config_path;
                info.set_status(crate::rclone::backend::runtime::RuntimeStatus::Connected);
                info
            }
            Err(e) => {
                log::warn!("Failed to fetch version for backend {}: {e}", self.name);
                RuntimeInfo::with_error(e)
            }
        }
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
        let mut builder = self.inject_auth(client.get(&url));

        if let Some(r) = range {
            builder = builder.header(reqwest::header::RANGE, r);
        }

        builder
            .send()
            .await
            .map_err(|e| format!("Failed to fetch remote file: {e}"))
    }

    /// Fetch a file's content using the `core/command` endpoint with `cat`.
    ///
    /// This is used as a fallback for remote backends where the standard serve
    /// endpoint might not support local files or specific remote configurations.
    pub async fn fetch_file_via_cat(
        &self,
        transport: &dyn crate::rclone::backend::RcloneTransport,
        remote: &str,
        path: &str,
        offset: Option<i64>,
        count: Option<i64>,
        os: Option<String>,
    ) -> Result<Vec<u8>, String> {
        let full_path = if remote.is_empty() || remote == ":" {
            path.to_string()
        } else {
            let r_name = if remote.ends_with(':') {
                remote.to_string()
            } else {
                format!("{remote}:")
            };
            crate::utils::json_helpers::build_full_path(&r_name, path)
        };

        let mut args = vec![full_path];
        if let Some(o) = offset {
            args.push(format!("--offset={o}"));
        }
        if let Some(c) = count {
            args.push(format!("--count={c}"));
        }

        let payload = self.build_core_command_payload("cat", args, false, os);
        let response = transport
            .rpc(core::COMMAND, Some(&payload))
            .await
            .map_err(|e| e.to_string())?;

        if response
            .get("error")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            let err_msg = response
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown rclone error");
            return Err(err_msg.to_string());
        }

        let result = response
            .get("result")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "No result in cat response".to_string())?;

        Ok(result.as_bytes().to_vec())
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
    async fn fetch_config_path(
        &self,
        transport: &dyn crate::rclone::backend::RcloneTransport,
    ) -> Result<PathBuf, String> {
        let paths = transport
            .rpc(config::PATHS, Some(&serde_json::json!({})))
            .await
            .map_err(|e| e.to_string())?;

        let config_path = paths
            .get("config")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "No config path in response".to_string())?;

        Ok(PathBuf::from(config_path))
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
                let escaped_pass = pass
                    .replace('^', "^^")
                    .replace('&', "^&")
                    .replace('|', "^|")
                    .replace('<', "^<")
                    .replace('>', "^>");
                args.push(format!("--password-command=cmd /C echo {escaped_pass}"));
            } else {
                let escaped_pass = pass.replace('\'', "'\\''");
                args.push(format!(
                    "--password-command=sh -c \"printf '%s' '{escaped_pass}'\""
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
    #[cfg(not(feature = "librclone"))]
    pub oauth_port: u16,
    #[cfg(not(feature = "librclone"))]
    pub oauth_host: String,
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
            #[cfg(not(feature = "librclone"))]
            oauth_port: backend.oauth_port,
            #[cfg(not(feature = "librclone"))]
            oauth_host: backend.oauth_host.clone(),
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

        #[cfg(not(feature = "librclone"))]
        {
            b.oauth_host = "::1".to_string();
            assert_eq!(b.oauth_url(), "http://[::1]:51901");
            assert_eq!(b.oauth_addr(), "[::1]:51901");
        }
    }

    #[test]
    #[cfg(not(feature = "librclone"))]
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

        assert!(!json.contains("\"name\""));
        assert!(json.contains("\"is_local\":true"));
        assert!(json.contains("\"host\":\"127.0.0.1\""));
        assert!(json.contains("\"oauth_port\":51901"));
        assert!(json.contains("\"oauth_host\":\"127.0.0.1\""));
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
        assert_eq!(backend.oauth_port, 51901);
        assert_eq!(backend.oauth_host, "127.0.0.1");
    }

    #[test]
    fn test_is_auth_generated_default() {
        let backend = Backend::new_local("Local");
        assert!(!backend.is_auth_generated);
    }
}
