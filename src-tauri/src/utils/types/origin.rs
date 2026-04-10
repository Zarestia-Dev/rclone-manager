use serde::{Deserialize, Serialize};

/// Where an operation was initiated from.
///
/// Stored on [`JobInfo`] for auditing; the notification system also uses it to
/// decide whether completion toasts should be suppressed when the app is focused.
///
/// # Suppression contract
///
/// [`Origin::is_user_facing`] returns `true` for origins where the user was
/// actively looking at a UI surface when they triggered the action. For those
/// origins, completion notifications are suppressed while the app window is
/// focused — the user can already see the result. Errors are always shown
/// regardless of origin (see [`NotificationEvent::suppression`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// User action in the main Tauri window.
    Ui,
    /// Cron / scheduled-task engine.
    Scheduler,
    /// App-internal logic (startup, watchdog, state-restore, etc.).
    System,
    /// Companion web dashboard.
    Dashboard,
    /// External file-manager plugin (Nautilus, Finder, etc.).
    FileManager,
}

impl Origin {
    /// `true` when the user was actively looking at a surface when they
    /// initiated the operation.
    ///
    /// Used by the notification system: completion toasts for user-facing
    /// origins are suppressed while the app window is focused.
    pub fn is_user_facing(&self) -> bool {
        matches!(self, Origin::Ui | Origin::Dashboard | Origin::FileManager)
    }

    /// Parse an origin tag arriving over IPC or from a file-manager plugin.
    /// Unknown values fall back to [`Origin::System`].
    pub fn parse(s: &str) -> Self {
        match s {
            "ui" => Origin::Ui,
            // Accept both spellings so existing serialised data keeps working.
            "scheduler" | "scheduled" => Origin::Scheduler,
            "dashboard" => Origin::Dashboard,
            // "nautilus" was the old name for the file-manager integration.
            "filemanager" | "nautilus" => Origin::FileManager,
            _ => Origin::System,
        }
    }

    /// Return a stable tag suitable for storage/IPC matching.
    pub fn as_str(&self) -> &str {
        match self {
            Origin::Ui => "ui",
            Origin::Scheduler => "scheduler",
            Origin::System => "system",
            Origin::Dashboard => "dashboard",
            Origin::FileManager => "filemanager",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_facing_variants() {
        assert!(Origin::Ui.is_user_facing());
        assert!(Origin::Dashboard.is_user_facing());
        assert!(Origin::FileManager.is_user_facing());
    }

    #[test]
    fn background_variants_not_user_facing() {
        assert!(!Origin::Scheduler.is_user_facing());
        assert!(!Origin::System.is_user_facing());
    }

    #[test]
    fn parse_legacy_strings() {
        assert_eq!(Origin::parse("nautilus"), Origin::FileManager);
        assert_eq!(Origin::parse("scheduled"), Origin::Scheduler);
        assert_eq!(Origin::parse("unknown_future_value"), Origin::System);
    }
}
