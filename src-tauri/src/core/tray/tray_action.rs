use log::warn;

/// Represents a specific action for a specific remote/profile in the tray menu.
#[derive(Debug, PartialEq)]
pub enum TrayAction {
    // Profile-specific actions (remote, profile)
    MountProfile(String, String),
    UnmountProfile(String, String),
    SyncProfile(String, String),
    StopSyncProfile(String, String),
    CopyProfile(String, String),
    StopCopyProfile(String, String),
    MoveProfile(String, String),
    StopMoveProfile(String, String),
    BisyncProfile(String, String),
    StopBisyncProfile(String, String),
    ServeProfile(String, String),
    StopServeProfile(String, String),

    // Remote-level actions
    Browse(String),
    BrowseInApp(String),
}

impl TrayAction {
    /// Converts a tray action into its unique string ID.
    /// Example: TrayAction::MountProfile("myRemote", "profile1") -> "mount_profile-myRemote-profile1"
    pub fn to_id(&self) -> String {
        match self {
            Self::MountProfile(remote, profile) => {
                format!("mount_profile__{}__{}", remote, profile)
            }
            Self::UnmountProfile(remote, profile) => {
                format!("unmount_profile__{}__{}", remote, profile)
            }
            Self::SyncProfile(remote, profile) => format!("sync_profile__{}__{}", remote, profile),
            Self::StopSyncProfile(remote, profile) => {
                format!("stop_sync_profile__{}__{}", remote, profile)
            }
            Self::CopyProfile(remote, profile) => format!("copy_profile__{}__{}", remote, profile),
            Self::StopCopyProfile(remote, profile) => {
                format!("stop_copy_profile__{}__{}", remote, profile)
            }
            Self::MoveProfile(remote, profile) => format!("move_profile__{}__{}", remote, profile),
            Self::StopMoveProfile(remote, profile) => {
                format!("stop_move_profile__{}__{}", remote, profile)
            }
            Self::BisyncProfile(remote, profile) => {
                format!("bisync_profile__{}__{}", remote, profile)
            }
            Self::StopBisyncProfile(remote, profile) => {
                format!("stop_bisync_profile__{}__{}", remote, profile)
            }
            Self::ServeProfile(remote, profile) => {
                format!("serve_profile__{}__{}", remote, profile)
            }
            Self::StopServeProfile(remote, profile) => {
                format!("stop_serve_profile__{}__{}", remote, profile)
            }
            Self::Browse(remote) => format!("browse-__{}", remote),
            Self::BrowseInApp(remote) => format!("browse_in_app__{}", remote),
        }
    }

    /// Parses a unique string ID back into a TrayAction.
    /// Example: "mount_profile__myRemote__profile1" -> Some(TrayAction::MountProfile("myRemote", "profile1"))
    pub fn from_id(id: &str) -> Option<Self> {
        let parts: Vec<&str> = id.splitn(3, "__").collect();

        if parts.len() == 2 {
            // Old-style action without profile (browse only)
            let (prefix, remote) = (parts[0], parts[1]);
            match prefix {
                "browse-" => return Some(Self::Browse(remote.to_string())),
                "browse_in_app" => return Some(Self::BrowseInApp(remote.to_string())),
                _ => return None,
            }
        }

        if parts.len() != 3 {
            warn!("Invalid tray menu ID format: {}", id);
            return None;
        }

        let (prefix, remote, profile) = (parts[0], parts[1].to_string(), parts[2].to_string());

        match prefix {
            "mount_profile" => Some(Self::MountProfile(remote, profile)),
            "unmount_profile" => Some(Self::UnmountProfile(remote, profile)),
            "sync_profile" => Some(Self::SyncProfile(remote, profile)),
            "stop_sync_profile" => Some(Self::StopSyncProfile(remote, profile)),
            "copy_profile" => Some(Self::CopyProfile(remote, profile)),
            "stop_copy_profile" => Some(Self::StopCopyProfile(remote, profile)),
            "move_profile" => Some(Self::MoveProfile(remote, profile)),
            "stop_move_profile" => Some(Self::StopMoveProfile(remote, profile)),
            "bisync_profile" => Some(Self::BisyncProfile(remote, profile)),
            "stop_bisync_profile" => Some(Self::StopBisyncProfile(remote, profile)),
            "serve_profile" => Some(Self::ServeProfile(remote, profile)),
            "stop_serve_profile" => Some(Self::StopServeProfile(remote, profile)),
            _ => {
                warn!("Unhandled tray menu ID prefix: {}", prefix);
                None
            }
        }
    }
}
