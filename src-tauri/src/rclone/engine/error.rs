use std::fmt;

/// Errors that can occur during engine operations
#[derive(Debug)]
pub enum EngineError {
    SpawnFailed(String),
    InvalidPath,
    KillFailed(String),
    PortCleanupFailed(String),
    ConfigValidationFailed(String),
    LockFailed(String),
    RestartFailed(String),
    CacheRefreshFailed(String),
    PasswordRequired,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::SpawnFailed(msg) => write!(f, "Spawn failed: {msg}"),
            EngineError::InvalidPath => write!(f, "Invalid rclone path"),
            EngineError::KillFailed(msg) => write!(f, "Kill failed: {msg}"),
            EngineError::PortCleanupFailed(msg) => write!(f, "Port cleanup failed: {msg}"),
            EngineError::ConfigValidationFailed(msg) => {
                write!(f, "Config validation failed: {msg}")
            }
            EngineError::LockFailed(msg) => write!(f, "Lock acquisition failed: {msg}"),
            EngineError::RestartFailed(msg) => write!(f, "Restart failed: {msg}"),
            EngineError::CacheRefreshFailed(msg) => write!(f, "Cache refresh failed: {msg}"),
            EngineError::PasswordRequired => write!(f, "Configuration password required"),
        }
    }
}

impl std::error::Error for EngineError {}

pub type EngineResult<T> = Result<T, EngineError>;

// Convert to String for backward compatibility
impl From<EngineError> for String {
    fn from(e: EngineError) -> Self {
        e.to_string()
    }
}
