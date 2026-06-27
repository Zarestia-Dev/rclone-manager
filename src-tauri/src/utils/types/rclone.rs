use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckResult {
    pub successful: Vec<String>,
    pub failed: HashMap<String, String>,
    pub retries_used: HashMap<String, usize>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiskUsageSeverity {
    Healthy,
    Warning,
    High,
    Critical,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub free: i64,
    pub used: i64,
    pub total: i64,
    pub usage_percentage: f64,
    pub usage_percentage_label: String,
    pub usage_severity: DiskUsageSeverity,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BandwidthLimitResponse {
    pub bytes_per_second: i64,
    pub bytes_per_second_rx: i64,
    pub bytes_per_second_tx: i64,
    pub rate: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RcloneCoreVersion {
    pub version: String,
    pub decomposed: Vec<u32>,
    pub go_version: String,
    pub os: String,
    pub arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_kernel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_arch: Option<String>,
    pub is_beta: bool,
    pub is_git: bool,
    pub linking: String,
    pub go_tags: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessKind {
    Engine,
    OAuth,
}
