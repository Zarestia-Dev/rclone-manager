use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

use crate::utils::types::origin::Origin;

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

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct ProfileParams {
    pub remote_name: String,
    pub profile_name: String,
    pub origin: Option<Origin>,
    pub no_cache: Option<bool>,
}
