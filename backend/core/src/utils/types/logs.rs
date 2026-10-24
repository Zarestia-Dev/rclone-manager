use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: DateTime<Utc>,
    pub remote_name: Option<String>,
    pub level: LogLevel,
    pub message: String,
    pub context: Option<Value>,
    pub operation: Option<String>, // e.g., "mount", "sync", "copy"
}

pub struct LogCache {
    pub entries: RwLock<Vec<LogEntry>>,
    pub max_entries: usize,
}
