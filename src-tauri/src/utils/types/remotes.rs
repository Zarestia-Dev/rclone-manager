use crate::utils::types::jobs::JobType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

pub const SOURCE_KEYS: &[&str] = &["source", "srcFs", "path1", "fs"];
pub const DEST_KEYS: &[&str] = &["dest", "dstFs", "path2", "mountPoint"];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct MountedRemote {
    pub fs: String,
    pub mount_point: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ServeInstance {
    pub id: String,
    pub addr: String,
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
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
    pub vfs_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_remote_profile: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
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

    /// All operational config keys (for iteration in migration, deletion detection, etc.)
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

    /// All helper config keys (for iteration in migration).
    pub const ALL: &[&str] = &[VFS, FILTER, BACKEND, RUNTIME_REMOTE];
}

/// Keys that belong in the `app` partition (vs `rclone`).
/// Used by `partition_profile_to_app_and_rclone` in migration.
pub const APP_PARTITION_KEYS: &[&str] = &[
    "autoStart",
    "cronEnabled",
    "cronExpression",
    "watchEnabled",
    "watchDelay",
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

    /// Load settings for a list of remotes and parse them type-safely into a Map.
    pub fn load_all(
        manager: &crate::core::settings::AppSettingsManager,
        remote_names: &[String],
    ) -> std::collections::HashMap<String, Self> {
        let remotes = match manager.sub_settings("remotes") {
            Ok(r) => r,
            Err(_) => return std::collections::HashMap::new(),
        };
        let all_values = remotes.get_all_values().unwrap_or_default();
        all_values
            .into_iter()
            .filter(|(name, _)| remote_names.contains(name))
            .filter_map(|(name, val)| {
                serde_json::from_value::<Self>(val)
                    .ok()
                    .map(|settings| (name, settings))
            })
            .collect()
    }
}
