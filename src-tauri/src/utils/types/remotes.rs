use crate::utils::types::jobs::{JobStatus, JobType};
use crate::utils::types::origin::Origin;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

pub const SOURCE_KEYS: &[&str] = &["source", "srcFs", "path1", "fs", "url"];
pub const DEST_KEYS: &[&str] = &["dest", "dstFs", "path2", "mountPoint"];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct MountedRemote {
    pub fs: String,
    pub mount_point: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

impl MountedRemote {
    #[must_use]
    pub fn new(fs: impl Into<String>, mount_point: impl Into<String>) -> Self {
        Self {
            fs: fs.into(),
            mount_point: mount_point.into(),
            profile: None,
            quick_run_id: None,
            execute_id: None,
            origin: None,
            workflow_id: None,
            node_id: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ServeInstance {
    pub id: String,
    pub addr: String,
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

impl ServeInstance {
    #[must_use]
    pub fn new(id: impl Into<String>, addr: impl Into<String>, params: Value) -> Self {
        Self {
            id: id.into(),
            addr: addr.into(),
            params,
            profile: None,
            quick_run_id: None,
            execute_id: None,
            origin: None,
            workflow_id: None,
            node_id: None,
        }
    }
}

/// Unified response returned when starting any operation (mount, serve, sync, etc.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationExecutionResult {
    pub execute_id: String,
    pub origin: Origin,
    pub operation_type: OperationType,
    pub remote_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    pub success: bool,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub start_time: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_addr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_point: Option<String>,
}

#[derive(Debug)]
pub struct RemoteCache {
    pub remotes: RwLock<Vec<String>>,
    pub configs: RwLock<serde_json::Value>,
    pub mounted: RwLock<Vec<MountedRemote>>,
    pub serves: RwLock<Vec<ServeInstance>>,
}

#[derive(Debug, Deserialize)]
pub struct ListOptions {
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileParams {
    pub remote_name: String,
    pub profile_name: String,
    pub source: Option<crate::utils::types::origin::Origin>,
    pub no_cache: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scoped_targets: Option<Vec<(String, String)>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_delay: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_changed_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_on_tray: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vfs_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_remote_profile: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct ProfileConfig {
    #[serde(default)]
    pub app: AppConfig,
    #[serde(default)]
    pub rclone: Value,
}

impl ProfileConfig {
    /// Parse a profile config value, handling both partitioned `{app, rclone}` and flat formats.
    pub fn parse_from_value(val: &serde_json::Value) -> Self {
        let is_partitioned = val.get("app").is_some() || val.get("rclone").is_some();
        if is_partitioned {
            serde_json::from_value(val.clone()).unwrap_or_else(|_| Self {
                app: AppConfig::default(),
                rclone: serde_json::Value::Null,
            })
        } else {
            let app: AppConfig = serde_json::from_value(val.clone()).unwrap_or_default();
            Self {
                app,
                rclone: val.clone(),
            }
        }
    }

    /// Return the raw source value (String or Array) if present in `rclone` config.
    #[must_use]
    pub fn source_value(&self) -> Option<&Value> {
        if let Value::Object(ref map) = self.rclone {
            SOURCE_KEYS.iter().find_map(|&key| map.get(key))
        } else {
            None
        }
    }

    /// Return the raw destination value if present in `rclone` config.
    #[must_use]
    pub fn dest_value(&self) -> Option<&Value> {
        if let Value::Object(ref map) = self.rclone {
            DEST_KEYS.iter().find_map(|&key| map.get(key))
        } else {
            None
        }
    }

    /// Return the destination path as a string slice if present.
    #[must_use]
    pub fn dest_str(&self) -> Option<&str> {
        self.dest_value().and_then(Value::as_str)
    }

    /// Return the source path as a string slice if present (or the first element if array).
    #[must_use]
    pub fn source_str(&self) -> Option<&str> {
        match self.source_value() {
            Some(Value::String(s)) => Some(s.as_str()),
            Some(Value::Array(arr)) => arr.first().and_then(Value::as_str),
            _ => None,
        }
    }
}

/// All operational profile config types and settings section keys.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum OperationType {
    #[serde(alias = "Mount")]
    Mount,
    #[serde(alias = "Sync")]
    Sync,
    #[serde(alias = "Copy")]
    Copy,
    #[serde(alias = "Move")]
    Move,
    #[serde(alias = "Bisync")]
    Bisync,
    #[serde(alias = "Serve")]
    Serve,
    #[serde(alias = "Check")]
    Check,
    #[serde(alias = "Delete")]
    Delete,
    #[serde(alias = "Copyurl")]
    Copyurl,
    #[serde(alias = "Archivecreate")]
    Archivecreate,
    #[serde(alias = "Cryptcheck")]
    Cryptcheck,
}

impl OperationType {
    /// The JSON key in `RemoteSettings` (e.g. `"mountConfigs"`)
    pub const fn config_key(self) -> &'static str {
        match self {
            Self::Mount => "mountConfigs",
            Self::Sync => "syncConfigs",
            Self::Copy => "copyConfigs",
            Self::Move => "moveConfigs",
            Self::Bisync => "bisyncConfigs",
            Self::Serve => "serveConfigs",
            Self::Check => "checkConfigs",
            Self::Delete => "deleteConfigs",
            Self::Copyurl => "copyurlConfigs",
            Self::Archivecreate => "archivecreateConfigs",
            Self::Cryptcheck => "cryptcheckConfigs",
        }
    }

    /// Lookup OperationType from a config_key string like `"syncConfigs"`
    pub fn from_config_key(key: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|op| op.config_key() == key)
    }

    /// Maps the operation to its corresponding `JobType`, if applicable.
    pub fn as_job_type(self) -> Option<JobType> {
        match self {
            Self::Mount => Some(JobType::Mount),
            Self::Sync => Some(JobType::Sync),
            Self::Copy => Some(JobType::Copy),
            Self::Move => Some(JobType::Move),
            Self::Bisync => Some(JobType::Bisync),
            Self::Check => Some(JobType::Check),
            Self::Delete => Some(JobType::Delete),
            Self::Copyurl => Some(JobType::CopyUrl),
            Self::Archivecreate => Some(JobType::ArchiveCreate),
            Self::Cryptcheck => Some(JobType::CryptCheck),
            Self::Serve => None,
        }
    }

    /// Maps the operation to its Rclone RC endpoint, if applicable.
    pub fn endpoint(self) -> Option<&'static str> {
        match self {
            Self::Sync => Some(crate::utils::rclone::endpoints::sync::SYNC),
            Self::Copy => Some(crate::utils::rclone::endpoints::sync::COPY),
            Self::Move => Some(crate::utils::rclone::endpoints::sync::MOVE),
            Self::Bisync => Some(crate::utils::rclone::endpoints::sync::BISYNC),
            Self::Check => Some(crate::utils::rclone::endpoints::operations::CHECK),
            Self::Delete => Some(crate::utils::rclone::endpoints::operations::PURGE),
            Self::Copyurl => Some(crate::utils::rclone::endpoints::operations::COPYURL),
            Self::Cryptcheck => Some(crate::utils::rclone::endpoints::operations::CRYPTCHECK),
            Self::Archivecreate => Some(crate::utils::rclone::endpoints::operations::ARCHIVE),
            _ => None,
        }
    }

    /// Checks if this is a directory/file transfer operation.
    pub fn is_transfer(self) -> bool {
        matches!(
            self,
            Self::Sync
                | Self::Copy
                | Self::Move
                | Self::Bisync
                | Self::Check
                | Self::Delete
                | Self::Copyurl
                | Self::Archivecreate
                | Self::Cryptcheck
        )
    }

    /// Checks if this operation supports cron/filesystem-watcher automation.
    pub fn is_automation(self) -> bool {
        matches!(
            self,
            Self::Sync
                | Self::Copy
                | Self::Move
                | Self::Bisync
                | Self::Check
                | Self::Delete
                | Self::Copyurl
                | Self::Archivecreate
                | Self::Cryptcheck
        )
    }

    /// Return the string representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mount => "mount",
            Self::Sync => "sync",
            Self::Copy => "copy",
            Self::Move => "move",
            Self::Bisync => "bisync",
            Self::Serve => "serve",
            Self::Check => "check",
            Self::Delete => "delete",
            Self::Copyurl => "copyurl",
            Self::Archivecreate => "archivecreate",
            Self::Cryptcheck => "cryptcheck",
        }
    }

    /// All operational config keys (for iteration, deletion detection, etc.)
    pub const ALL: &[Self] = &[
        Self::Mount,
        Self::Sync,
        Self::Copy,
        Self::Move,
        Self::Bisync,
        Self::Serve,
        Self::Check,
        Self::Delete,
        Self::Copyurl,
        Self::Archivecreate,
        Self::Cryptcheck,
    ];
}

impl std::str::FromStr for OperationType {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "mount" => Ok(Self::Mount),
            "sync" => Ok(Self::Sync),
            "copy" => Ok(Self::Copy),
            "move" => Ok(Self::Move),
            "bisync" => Ok(Self::Bisync),
            "serve" => Ok(Self::Serve),
            "check" => Ok(Self::Check),
            "delete" => Ok(Self::Delete),
            "copyurl" => Ok(Self::Copyurl),
            "archivecreate" => Ok(Self::Archivecreate),
            "cryptcheck" => Ok(Self::Cryptcheck),
            _ => Err(()),
        }
    }
}

impl std::fmt::Display for OperationType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mount => write!(f, "Mount"),
            Self::Sync => write!(f, "Sync"),
            Self::Copy => write!(f, "Copy"),
            Self::Move => write!(f, "Move"),
            Self::Bisync => write!(f, "Bisync"),
            Self::Serve => write!(f, "Serve"),
            Self::Check => write!(f, "Check"),
            Self::Delete => write!(f, "Delete"),
            Self::Copyurl => write!(f, "Copyurl"),
            Self::Archivecreate => write!(f, "Archivecreate"),
            Self::Cryptcheck => write!(f, "Cryptcheck"),
        }
    }
}

/// Helper profile config section keys.
pub mod helper_config_keys {
    pub const VFS: &str = "vfsConfigs";
    pub const FILTER: &str = "filterConfigs";
    pub const BACKEND: &str = "backendConfigs";
    pub const RUNTIME_REMOTE: &str = "runtimeRemoteConfigs";

    /// All helper config keys.
    pub const ALL: &[&str] = &[VFS, FILTER, BACKEND, RUNTIME_REMOTE];
}

/// Keys that belong in the `app` partition (vs `rclone`).
pub const APP_PARTITION_KEYS: &[&str] = &[
    "autoStart",
    "cronEnabled",
    "cronExpression",
    "watchEnabled",
    "watchDelay",
    "watchChangedOnly",
    "showOnTray",
    "vfsProfile",
    "filterProfile",
    "backendProfile",
    "runtimeRemoteProfile",
];

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_actions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_actions: Option<Vec<String>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub move_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bisync_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copyurl_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archivecreate_configs: Option<std::collections::HashMap<String, ProfileConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cryptcheck_configs: Option<std::collections::HashMap<String, ProfileConfig>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_configs: Option<std::collections::HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_configs: Option<std::collections::HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vfs_configs: Option<std::collections::HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_remote_configs: Option<std::collections::HashMap<String, serde_json::Value>>,

    #[cfg(feature = "tray")]
    #[serde(default)]
    pub show_on_tray: bool,
}

impl RemoteSettings {
    /// Load settings for a specific remote and parse them type-safely.
    pub fn load(
        manager: &crate::core::settings::AppSettingsManager,
        remote_name: &str,
    ) -> Result<Self, String> {
        let remotes = manager
            .sub_settings("remotes")
            .map_err(|e| format!("Failed to get remotes sub-settings: {e}"))?;
        let val = remotes
            .get_value(remote_name)
            .map_err(|_| format!("Remote '{remote_name}' settings not found"))?;
        serde_json::from_value(val).map_err(|e| format!("Invalid remote settings format: {e}"))
    }

    /// Load settings for all stored remotes and parse them type-safely into a Map.
    pub fn load_all(
        manager: &crate::core::settings::AppSettingsManager,
    ) -> std::collections::HashMap<String, Self> {
        let remotes = match manager.sub_settings("remotes") {
            Ok(r) => r,
            Err(_) => return std::collections::HashMap::new(),
        };
        let all_values = remotes.get_all_values().unwrap_or_default();
        all_values
            .into_iter()
            .filter_map(|(name, val)| {
                serde_json::from_value::<Self>(val)
                    .ok()
                    .map(|settings| (name, settings))
            })
            .collect()
    }

    /// Returns the profile configs map for the given operation type.
    pub fn get_configs(
        &self,
        op: OperationType,
    ) -> Option<&std::collections::HashMap<String, ProfileConfig>> {
        match op {
            OperationType::Mount => self.mount_configs.as_ref(),
            OperationType::Sync => self.sync_configs.as_ref(),
            OperationType::Copy => self.copy_configs.as_ref(),
            OperationType::Move => self.move_configs.as_ref(),
            OperationType::Bisync => self.bisync_configs.as_ref(),
            OperationType::Serve => self.serve_configs.as_ref(),
            OperationType::Check => self.check_configs.as_ref(),
            OperationType::Delete => self.delete_configs.as_ref(),
            OperationType::Copyurl => self.copyurl_configs.as_ref(),
            OperationType::Archivecreate => self.archivecreate_configs.as_ref(),
            OperationType::Cryptcheck => self.cryptcheck_configs.as_ref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_profile_config_source_dest_helpers() {
        let profile = ProfileConfig {
            app: AppConfig::default(),
            rclone: json!({
                "srcFs": "remote:bucket/folder",
                "dstFs": "/home/user/data",
            }),
        };

        assert_eq!(profile.source_str(), Some("remote:bucket/folder"));
        assert_eq!(profile.dest_str(), Some("/home/user/data"));

        // Array source test
        let array_profile = ProfileConfig {
            app: AppConfig::default(),
            rclone: json!({
                "source": ["first:path", "second:path"],
                "mountPoint": "/mnt/remote",
            }),
        };

        assert_eq!(array_profile.source_str(), Some("first:path"));
        assert_eq!(array_profile.dest_str(), Some("/mnt/remote"));

        // Empty / missing test
        let empty_profile = ProfileConfig::default();
        assert_eq!(empty_profile.source_str(), None);
        assert_eq!(empty_profile.dest_str(), None);
    }

    #[test]
    fn test_operation_type_config_key_bidirectional() {
        for &op in OperationType::ALL {
            let key = op.config_key();
            assert_eq!(OperationType::from_config_key(key), Some(op));
        }

        assert_eq!(OperationType::from_config_key("unknownKey"), None);
    }

    #[test]
    fn test_remote_settings_get_configs() {
        let mut settings = RemoteSettings::default();
        let mut sync_map = std::collections::HashMap::new();
        sync_map.insert("default".to_string(), ProfileConfig::default());
        settings.sync_configs = Some(sync_map);

        assert!(settings.get_configs(OperationType::Sync).is_some());
        assert_eq!(settings.get_configs(OperationType::Sync).unwrap().len(), 1);
        assert!(settings.get_configs(OperationType::Copy).is_none());
    }
}
