use log::warn;

/// Represents a specific action for a specific remote in the tray menu.
#[derive(Debug, PartialEq)]
pub enum TrayAction {
    Mount(String),
    Unmount(String),
    Sync(String),
    StopSync(String),
    Copy(String),
    StopCopy(String),
    Move(String),
    StopMove(String),
    Bisync(String),
    StopBisync(String),
    Browse(String),
    Serve(String),
    StopServe(String),
}

impl TrayAction {
    /// Converts a tray action into its unique string ID.
    /// Example: TrayAction::Mount("myRemote") -> "mount-myRemote"
    pub fn to_id(&self) -> String {
        match self {
            Self::Mount(remote) => format!("mount-{}", remote),
            Self::Unmount(remote) => format!("unmount-{}", remote),
            Self::Sync(remote) => format!("sync-{}", remote),
            Self::StopSync(remote) => format!("stop_sync-{}", remote),
            Self::Copy(remote) => format!("copy-{}", remote),
            Self::StopCopy(remote) => format!("stop_copy-{}", remote),
            Self::Move(remote) => format!("move-{}", remote),
            Self::StopMove(remote) => format!("stop_move-{}", remote),
            Self::Bisync(remote) => format!("bisync-{}", remote),
            Self::StopBisync(remote) => format!("stop_bisync-{}", remote),
            Self::Browse(remote) => format!("browse-{}", remote),
            Self::Serve(remote) => format!("serve-{}", remote),
            Self::StopServe(remote) => format!("stop_serve-{}", remote),
        }
    }

    /// Parses a unique string ID back into a TrayAction.
    /// Example: "mount-myRemote" -> Some(TrayAction::Mount("myRemote"))
    pub fn from_id(id: &str) -> Option<Self> {
        let (prefix, remote) = id.split_once('-')?;

        // This clone is cheap since `remote` is just a string slice.
        let remote_name = remote.to_string();

        match prefix {
            "mount" => Some(Self::Mount(remote_name)),
            "unmount" => Some(Self::Unmount(remote_name)),
            "sync" => Some(Self::Sync(remote_name)),
            "stop_sync" => Some(Self::StopSync(remote_name)),
            "copy" => Some(Self::Copy(remote_name)),
            "stop_copy" => Some(Self::StopCopy(remote_name)),
            "move" => Some(Self::Move(remote_name)),
            "stop_move" => Some(Self::StopMove(remote_name)),
            "bisync" => Some(Self::Bisync(remote_name)),
            "stop_bisync" => Some(Self::StopBisync(remote_name)),
            "browse" => Some(Self::Browse(remote_name)),
            "serve" => Some(Self::Serve(remote_name)),
            "stop_serve" => Some(Self::StopServe(remote_name)),
            _ => {
                warn!("Unhandled tray menu ID prefix: {}", prefix);
                None
            }
        }
    }
}
