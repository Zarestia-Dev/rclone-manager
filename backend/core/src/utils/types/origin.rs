use serde::{Deserialize, Serialize};

/// Where an operation was initiated from or the functional domain it belongs to.
///
/// Stored on [`JobInfo`] for auditing; the alert system uses it to categorize
/// history and decide whether completion toasts should be suppressed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Action initiated from the main application Dashboard.
    Dashboard,
    /// Automation task.
    Automation,
    /// Integration with OS shell (Nautilus, Finder, etc.).
    FileManager,
    /// Initial application boot and environment setup.
    Startup,
    /// Software update lifecycle (App or Rclone).
    Update,
    /// Background system processes (disk usage, directory sorting, cleanup).
    #[default]
    Internal,
    /// Flow workspace operation.
    Flow,
    /// Quick Run preset execution.
    QuickRun,
}

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl Origin {
    /// `true` when the user was actively looking at a surface when they
    /// initiated the operation.
    #[must_use]
    pub fn is_user_facing(&self) -> bool {
        matches!(
            self,
            Origin::Dashboard | Origin::FileManager | Origin::Flow | Origin::QuickRun
        )
    }

    /// Return a stable tag suitable for storage/IPC matching.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Origin::Dashboard => "dashboard",
            Origin::Automation => "automation",
            Origin::FileManager => "filemanager",
            Origin::Startup => "startup",
            Origin::Update => "update",
            Origin::Internal => "internal",
            Origin::Flow => "flow",
            Origin::QuickRun => "quickrun",
        }
    }
}
