use crate::utils::types::remotes::OperationType;
use log::warn;

/// Represents a specific action for a specific remote/profile in the tray menu.
#[derive(Debug, PartialEq, Clone)]
pub enum TrayAction {
    // Dynamic profile-specific actions (operation_type, remote, profile)
    StartProfile(OperationType, String, String),
    StopProfile(OperationType, String, String),

    // Remote-level actions
    Browse(String),
    BrowseInApp(String),

    // Global actions
    UnmountAll,
    StopAllJobs,
    StopAllServes,
    OpenFileBrowser,
    ShowApp,
    OpenWebUI,
    Quit,
}

impl TrayAction {
    /// Converts a tray action into its unique string ID.
    /// Example: `TrayAction::StartProfile(OperationType::Mount, "myRemote", "profile1") -> "mount_profile__myRemote__profile1"`
    pub fn to_id(&self) -> String {
        match self {
            Self::StartProfile(op, remote, profile) => {
                format!("{}_profile__{remote}__{profile}", op.as_str())
            }
            Self::StopProfile(op, remote, profile) => {
                if *op == OperationType::Mount {
                    format!("unmount_profile__{remote}__{profile}")
                } else {
                    format!("stop_{}_profile__{remote}__{profile}", op.as_str())
                }
            }
            Self::Browse(remote) => format!("browse_remote__{remote}"),
            Self::BrowseInApp(remote) => format!("browse_in_app__{remote}"),
            Self::UnmountAll => "unmount_all".to_string(),
            Self::StopAllJobs => "stop_all_jobs".to_string(),
            Self::StopAllServes => "stop_all_serves".to_string(),
            Self::OpenFileBrowser => "open_file_browser".to_string(),
            Self::ShowApp => "show_app".to_string(),
            Self::OpenWebUI => "open_web_ui".to_string(),
            Self::Quit => "quit".to_string(),
        }
    }

    /// Parses a unique string ID back into a `TrayAction`.
    /// Example: "`mount_profile__myRemote__profile1`" -> `Some(TrayAction::StartProfile(OperationType::Mount, "myRemote", "profile1"))`
    pub fn from_id(id: &str) -> Option<Self> {
        // Check for global actions first (single word, no separators)
        match id {
            "unmount_all" => return Some(Self::UnmountAll),
            "stop_all_jobs" => return Some(Self::StopAllJobs),
            "stop_all_serves" => return Some(Self::StopAllServes),
            "open_file_browser" => return Some(Self::OpenFileBrowser),
            "show_app" => return Some(Self::ShowApp),
            "open_web_ui" => return Some(Self::OpenWebUI),
            "quit" => return Some(Self::Quit),
            _ => {}
        }

        let parts: Vec<&str> = id.splitn(3, "__").collect();

        if parts.len() == 2 {
            // Action without profile (browse or global)
            let (prefix, remote) = (parts[0], parts[1]);
            match prefix {
                "browse_remote" => return Some(Self::Browse(remote.to_string())),
                "browse_in_app" => return Some(Self::BrowseInApp(remote.to_string())),
                _ => return None,
            }
        }

        if parts.len() != 3 {
            warn!("Invalid tray menu ID format: {id}");
            return None;
        }

        let (prefix, remote, profile) = (parts[0], parts[1].to_string(), parts[2].to_string());

        if prefix == "unmount_profile" {
            return Some(Self::StopProfile(OperationType::Mount, remote, profile));
        }

        if let Some(op_str) = prefix.strip_prefix("stop_")
            && let Some(op_str_clean) = op_str.strip_suffix("_profile")
            && let Ok(op) = op_str_clean.parse::<OperationType>()
        {
            return Some(Self::StopProfile(op, remote, profile));
        }

        if let Some(op_str_clean) = prefix.strip_suffix("_profile")
            && let Ok(op) = op_str_clean.parse::<OperationType>()
        {
            return Some(Self::StartProfile(op, remote, profile));
        }

        warn!("Unhandled tray menu ID prefix: {prefix}");
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tray_action_id_roundtrip() {
        let actions = vec![
            TrayAction::StartProfile(
                OperationType::Mount,
                "myRemote".to_string(),
                "profile1".to_string(),
            ),
            TrayAction::StopProfile(
                OperationType::Mount,
                "myRemote".to_string(),
                "profile1".to_string(),
            ),
            TrayAction::StartProfile(OperationType::Sync, "remote".to_string(), "p".to_string()),
            TrayAction::StartProfile(OperationType::Check, "remote".to_string(), "p".to_string()),
            TrayAction::StopProfile(OperationType::Check, "remote".to_string(), "p".to_string()),
            TrayAction::Browse("remote".to_string()),
            TrayAction::BrowseInApp("remote".to_string()),
            TrayAction::UnmountAll,
            TrayAction::OpenFileBrowser,
            TrayAction::ShowApp,
            TrayAction::OpenWebUI,
            TrayAction::Quit,
        ];

        for action in actions {
            let id = action.to_id();
            let parsed =
                TrayAction::from_id(&id).unwrap_or_else(|| panic!("Should parse back: {id}"));
            assert_eq!(action, parsed);
        }
    }

    #[test]
    fn test_legacy_browse_id() {
        let id = "browse_remote__myRemote";
        let parsed = TrayAction::from_id(id).unwrap();
        assert_eq!(parsed, TrayAction::Browse("myRemote".to_string()));
    }
}
