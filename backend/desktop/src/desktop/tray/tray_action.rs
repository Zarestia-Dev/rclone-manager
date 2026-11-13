use crate::utils::types::remotes::OperationType;
use log::warn;

/// Represents a specific action for a specific remote/profile in the tray menu.
#[derive(Debug, PartialEq, Clone)]
pub enum TrayAction {
    // Dynamic profile-specific actions (operation_type, remote, profile)
    StartProfile(OperationType, String, String),
    StopProfile(OperationType, String, String),

    // Quick run actions
    StartQuickRun(String),
    StopQuickRun(String),

    // Workflow actions
    StartWorkflow(String),
    StopWorkflow(String),

    // Remote-level actions
    Browse(String, String),
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

/// IDs join their parts with `__`, so `_` (and `%`) inside a part are percent-encoded.
fn encode_part(part: &str) -> String {
    urlencoding::encode(part).replace('_', "%5F")
}

fn decode_part(part: &str) -> String {
    urlencoding::decode(part).map_or_else(|_| part.to_string(), std::borrow::Cow::into_owned)
}

impl TrayAction {
    /// Actions that do not expose configuration or control operations while locked.
    pub fn allowed_when_locked(&self) -> bool {
        matches!(self, Self::ShowApp | Self::OpenWebUI | Self::Quit)
    }

    /// Converts a tray action into its unique string ID.
    /// Example: `TrayAction::StartProfile(OperationType::Mount, "myRemote", "profile1") -> "mount_profile__myRemote__profile1"`
    pub fn to_id(&self) -> String {
        match self {
            Self::StartProfile(op, remote, profile) => {
                format!(
                    "{}_profile__{}__{}",
                    op.as_str(),
                    encode_part(remote),
                    encode_part(profile)
                )
            }
            Self::StopProfile(op, remote, profile) => {
                let (remote, profile) = (encode_part(remote), encode_part(profile));
                if *op == OperationType::Mount {
                    format!("unmount_profile__{remote}__{profile}")
                } else {
                    format!("stop_{}_profile__{remote}__{profile}", op.as_str())
                }
            }
            Self::StartQuickRun(id) => format!("start_quick_run__{}", encode_part(id)),
            Self::StopQuickRun(id) => format!("stop_quick_run__{}", encode_part(id)),
            Self::StartWorkflow(id) => format!("start_workflow__{}", encode_part(id)),
            Self::StopWorkflow(id) => format!("stop_workflow__{}", encode_part(id)),
            Self::Browse(remote, profile) => {
                format!(
                    "browse_profile__{}__{}",
                    encode_part(remote),
                    encode_part(profile)
                )
            }
            Self::BrowseInApp(remote) => format!("browse_in_app__{}", encode_part(remote)),
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

        let parts: Vec<&str> = id.split("__").collect();

        if parts.len() == 2 {
            // Action without 3-part profile (browse-in-app, quick run, or workflow)
            let (prefix, payload) = (parts[0], parts[1]);
            match prefix {
                "browse_in_app" => return Some(Self::BrowseInApp(decode_part(payload))),
                "start_quick_run" => return Some(Self::StartQuickRun(decode_part(payload))),
                "stop_quick_run" => return Some(Self::StopQuickRun(decode_part(payload))),
                "start_workflow" => return Some(Self::StartWorkflow(decode_part(payload))),
                "stop_workflow" => return Some(Self::StopWorkflow(decode_part(payload))),
                _ => return None,
            }
        }

        if parts.len() != 3 {
            warn!("Invalid tray menu ID format: {id}");
            return None;
        }

        let (prefix, remote, profile) = (parts[0], decode_part(parts[1]), decode_part(parts[2]));

        if prefix == "browse_profile" {
            return Some(Self::Browse(remote, profile));
        }

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
            TrayAction::StartQuickRun("qr-test-123".to_string()),
            TrayAction::StopQuickRun("qr-test-123".to_string()),
            TrayAction::StartWorkflow("wf-test-123".to_string()),
            TrayAction::StopWorkflow("wf-test-123".to_string()),
            TrayAction::Browse("remote".to_string(), "profile1".to_string()),
            TrayAction::BrowseInApp("remote".to_string()),
            TrayAction::UnmountAll,
            TrayAction::StopAllJobs,
            TrayAction::StopAllServes,
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
    fn ids_survive_names_that_contain_the_separator() {
        for name in [
            "my__remote",
            "_lead",
            "trail_",
            "a%5Fb",
            "100%",
            "Foto ğraf",
            "x__y__z",
        ] {
            for action in [
                TrayAction::StartProfile(OperationType::Sync, name.into(), name.into()),
                TrayAction::StopProfile(OperationType::Mount, name.into(), name.into()),
                TrayAction::StopProfile(OperationType::Serve, "r".into(), name.into()),
                TrayAction::Browse(name.into(), "p".into()),
                TrayAction::BrowseInApp(name.into()),
                TrayAction::StartQuickRun(name.into()),
                TrayAction::StopWorkflow(name.into()),
            ] {
                let id = action.to_id();
                assert_eq!(TrayAction::from_id(&id), Some(action), "{id}");
            }
        }
    }

    #[test]
    fn unknown_or_malformed_ids_are_ignored() {
        for id in [
            "",
            "status__remote",
            "bogus__a__b",
            "sync_profile__only",
            "a__b__c__d",
        ] {
            assert_eq!(TrayAction::from_id(id), None, "{id}");
        }
    }
}
