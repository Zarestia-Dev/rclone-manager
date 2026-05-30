use super::rclone::RcloneCoreVersion;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
pub struct NetworkStatusPayload {
    #[serde(rename = "isMetered")]
    pub is_metered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SystemStatus {
    Active,
    Inactive,
    Error,
}

/// Payload for consolidated system status updates (Phase 2 optimization)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatusPayload {
    /// Rclone version info (from cache)
    pub rclone_info: Option<RcloneCoreVersion>,
    /// Rclone process ID (from cache)
    pub pid: Option<u32>,
    /// Global transfer stats (from core/stats)
    pub stats: serde_json::Value,
    /// Memory statistics (from core/memstats)
    pub memory: serde_json::Value,
    /// Overall rclone status ("active", "inactive", etc.)
    pub status: SystemStatus,
    /// Whether there are any active jobs running
    pub has_active_jobs: bool,
}

impl SystemStatusPayload {
    #[must_use]
    pub fn inactive() -> Self {
        Self {
            rclone_info: None,
            pid: None,
            stats: serde_json::json!({}),
            memory: serde_json::json!({}),
            status: SystemStatus::Inactive,
            has_active_jobs: false,
        }
    }

    #[must_use]
    pub fn error() -> Self {
        Self {
            rclone_info: None,
            pid: None,
            stats: serde_json::json!({}),
            memory: serde_json::json!({}),
            status: SystemStatus::Error,
            has_active_jobs: false,
        }
    }
}
