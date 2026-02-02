use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::RwLock;

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
    /// Tracks mount_point → profile mapping (since rclone API doesn't return profile)
    pub mount_profiles: RwLock<HashMap<String, String>>,
    /// Tracks serve_id → profile mapping (since rclone API doesn't return profile)
    pub serve_profiles: RwLock<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
pub struct ListOptions {
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct ProfileParams {
    pub remote_name: String,
    pub profile_name: String,
}
