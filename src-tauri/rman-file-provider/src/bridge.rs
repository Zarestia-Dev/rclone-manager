//! HTTP bridge to rclone's RC API.
//!
//! Reads the rclone endpoint from the App Group shared container and makes
//! HTTP POST requests to the rclone RC API. This is the same pattern used by
//! Nextcloud's `NKBackground` and ownCloud's `OCCore` — the extension talks
//! directly to the backend rather than proxying through a main app process.

use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct RcloneEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
    pub mod_time: Option<i64>,
    #[allow(dead_code)]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RcloneStat {
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
    pub mod_time: Option<i64>,
}

#[derive(Deserialize)]
struct EndpointInfo {
    rc_url: String,
}

/// Bridge to rclone RC API. Follows the same pattern as Nextcloud's
/// `NKBackground` — stateless HTTP operations against the backend.
pub struct RcloneBridge {
    rc_url: String,
    client: reqwest::blocking::Client,
}

impl RcloneBridge {
    pub fn load() -> Option<Self> {
        let path = Self::endpoint_info_path()?;
        let mut file = std::fs::File::open(&path).ok()?;
        let mut contents = String::new();
        file.read_to_string(&mut contents).ok()?;
        let info: EndpointInfo = serde_json::from_str(&contents).ok()?;

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .ok()?;

        Some(Self {
            rc_url: info.rc_url,
            client,
        })
    }

    fn endpoint_info_path() -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(format!(
            "{}/Library/Group Containers/group.com.rclone.manager/rclone-endpoint.json",
            home
        )))
    }

    pub fn post(&self, endpoint: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}/{}", self.rc_url.trim_end_matches('/'), endpoint);
        let resp = self
            .client
            .post(&url)
            .json(body)
            .send()
            .map_err(|e| format!("rclone RC request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().unwrap_or_default();
            return Err(format!("rclone RC error {status}: {text}"));
        }

        resp.json::<Value>()
            .map_err(|e| format!("Failed to parse rclone response: {e}"))
    }

    pub fn list_remotes(&self) -> Vec<String> {
        self.post("config/listremotes", &serde_json::json!({}))
            .ok()
            .and_then(|v| v.get("remotes")?.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    }

    pub fn list(&self, path: &str) -> Vec<RcloneEntry> {
        let body = serde_json::json!({
            "fs": path,
            "remote": "",
            "opt": { "filesOnly": false, "dirsOnly": false }
        });
        let response = match self.post("operations/list", &body) {
            Ok(v) => v,
            Err(e) => {
                log::error!("Failed to list {path}: {e}");
                return vec![];
            }
        };

        response
            .get("list")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let name = item.get("Name")?.as_str()?.to_string();
                        let is_dir = item.get("IsDir").and_then(|v| v.as_bool()).unwrap_or(false);
                        let size = item.get("Size").and_then(|v| v.as_i64()).unwrap_or(0);
                        let mod_time = item
                            .get("ModTime")
                            .and_then(|v| v.as_str())
                            .and_then(|s| Self::parse_rclone_time(s));
                        let mime_type = item
                            .get("MimeType")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        Some(RcloneEntry {
                            name,
                            is_dir,
                            size,
                            mod_time,
                            mime_type,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn stat(&self, path: &str) -> Result<RcloneStat, String> {
        let body = serde_json::json!({ "fs": path, "remote": "" });
        let response = self.post("operations/stat", &body)?;

        let item = response
            .get("item")
            .and_then(|v| v.as_object())
            .ok_or_else(|| format!("No 'item' in stat response for {path}"))?;

        let name = item
            .get("Name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("No 'Name' in stat response for {path}"))?
            .to_string();

        let is_dir = item.get("IsDir").and_then(|v| v.as_bool()).unwrap_or(false);
        let size = item.get("Size").and_then(|v| v.as_i64()).unwrap_or(0);
        let mod_time = item
            .get("ModTime")
            .and_then(|v| v.as_str())
            .and_then(|s| Self::parse_rclone_time(s));

        Ok(RcloneStat {
            name,
            is_dir,
            size,
            mod_time,
        })
    }

    /// Download a file to a local path using `operations/cat`, streaming to avoid buffering.
    pub fn download(&self, path: &str, dest: &std::path::Path) -> Result<(), String> {
        let body = serde_json::json!({ "fs": path, "remote": "" });
        let url = format!("{}/operations/cat", self.rc_url.trim_end_matches('/'));

        let mut resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .map_err(|e| format!("download request: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("download failed: {}", resp.status()));
        }

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create download dir: {e}"))?;
        }

        let mut file = std::fs::File::create(dest).map_err(|e| format!("create dest file: {e}"))?;

        std::io::copy(&mut resp, &mut file).map_err(|e| format!("write file: {e}"))?;

        Ok(())
    }

    /// Upload a local file to a remote path using `operations/uploadfile`.
    pub fn upload(&self, remote_path: &str, source: &std::path::Path) -> Result<(), String> {
        let url = format!(
            "{}/operations/uploadfile",
            self.rc_url.trim_end_matches('/')
        );

        let (fs, remote) = match remote_path.find(':') {
            Some(i) => remote_path.split_at(i + 1),
            None => (remote_path, ""),
        };

        let filename = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();

        let content = std::fs::read(source).map_err(|e| format!("read source file: {e}"))?;

        let part = reqwest::blocking::multipart::Part::bytes(content).file_name(filename);

        let form = reqwest::blocking::multipart::Form::new().part("file", part);

        let resp = self
            .client
            .post(&url)
            .query(&[("fs", fs), ("remote", remote)])
            .multipart(form)
            .send()
            .map_err(|e| format!("upload request: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("upload failed: {}", resp.status()));
        }

        Ok(())
    }

    pub fn delete(&self, path: &str) -> Result<(), String> {
        let body = serde_json::json!({ "fs": path, "remote": "" });
        self.post("operations/deletefile", &body)?;
        Ok(())
    }

    pub fn mkdir(&self, path: &str) -> Result<(), String> {
        let body = serde_json::json!({ "fs": path, "remote": "" });
        self.post("operations/mkdir", &body)?;
        Ok(())
    }

    fn parse_rclone_time(s: &str) -> Option<i64> {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.timestamp());
        }
        // rclone sometimes emits nanosecond timestamps without timezone offset
        let trimmed = s.trim_end_matches('Z');
        chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S.%f")
            .ok()
            .map(|dt| dt.and_utc().timestamp())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rfc3339() {
        let ts = RcloneBridge::parse_rclone_time("2024-03-15T10:30:00Z");
        assert_eq!(ts, Some(1710498600));
    }

    #[test]
    fn parse_rfc3339_with_offset() {
        let ts = RcloneBridge::parse_rclone_time("2024-03-15T11:30:00+01:00");
        assert_eq!(ts, Some(1710498600));
    }

    #[test]
    fn parse_nanosecond_format() {
        // rclone sometimes emits this without timezone
        let ts = RcloneBridge::parse_rclone_time("2024-03-15T10:30:00.000000000Z");
        assert!(ts.is_some());
    }

    #[test]
    fn parse_invalid_returns_none() {
        assert!(RcloneBridge::parse_rclone_time("not a date").is_none());
        assert!(RcloneBridge::parse_rclone_time("").is_none());
    }

    #[test]
    fn endpoint_info_path_contains_group_container() {
        let path = RcloneBridge::endpoint_info_path();
        assert!(path.is_some());
        let p = path.unwrap();
        let s = p.to_str().unwrap();
        assert!(s.contains("Group Containers"));
        assert!(s.contains("group.com.rclone.manager"));
        assert!(s.ends_with("rclone-endpoint.json"));
    }
}
