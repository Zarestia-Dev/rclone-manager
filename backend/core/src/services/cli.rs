//! Shared paths and Send To options. Each executable owns its CLI parser.
use clap::Args;
use std::path::PathBuf;

/// General arguments available in all build modes
#[derive(Args, Debug, Clone)]
pub struct GeneralArgs {
    /// Path to data directory (overrides default/env)
    #[arg(long, env = "RCLONE_MANAGER_DATA_DIR")]
    pub data_dir: Option<PathBuf>,

    /// Path to cache directory (overrides default/env)
    #[arg(long, env = "RCLONE_MANAGER_CACHE_DIR")]
    pub cache_dir: Option<PathBuf>,

    /// Path to logs directory (overrides default/env)
    #[arg(long, env = "RCLONE_MANAGER_LOG_DIR")]
    pub logs_dir: Option<PathBuf>,

    /// Send files/folders to a remote destination (Windows SendTo integration)
    #[arg(long)]
    pub send_to_remote: Option<String>,

    /// Destination path on the remote (Windows SendTo integration)
    #[arg(long)]
    pub send_to_path: Option<String>,

    /// Source paths to send (Windows SendTo integration)
    pub send_to_sources: Vec<PathBuf>,
}

impl GeneralArgs {
    pub fn validate(&self) -> Result<(), String> {
        // SendTo validation
        if self.send_to_path.is_some() && self.send_to_remote.is_none() {
            return Err("Cannot use --send-to-path without specifying a destination remote via --send-to-remote".into());
        }

        if self.send_to_remote.is_some() && self.send_to_sources.is_empty() {
            return Err(
                "At least one source file or folder must be provided when using --send-to-remote"
                    .into(),
            );
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[derive(Parser)]
    struct CliArgs {
        #[command(flatten)]
        general: GeneralArgs,
    }
    #[test]
    fn test_general_paths() {
        let args = CliArgs::parse_from([
            "rclone-manager",
            "--data-dir",
            "/data",
            "--cache-dir",
            "/cache",
        ]);
        assert_eq!(args.general.data_dir, Some(PathBuf::from("/data")));
        assert_eq!(args.general.cache_dir, Some(PathBuf::from("/cache")));
    }

    #[test]
    fn test_send_to_args() {
        let args = CliArgs::parse_from([
            "rclone-manager",
            "--send-to-remote",
            "Dropbox:",
            "--send-to-path",
            "/Photos",
            "C:\\file1.txt",
            "C:\\file2.txt",
        ]);
        assert_eq!(args.general.send_to_remote, Some("Dropbox:".to_string()));
        assert_eq!(args.general.send_to_path, Some("/Photos".to_string()));
        assert_eq!(
            args.general.send_to_sources,
            vec![
                PathBuf::from("C:\\file1.txt"),
                PathBuf::from("C:\\file2.txt")
            ]
        );
    }

    #[test]
    fn test_validate_send_to() {
        // Failing: path without remote
        let args = CliArgs::parse_from(["rclone-manager", "--send-to-path", "/Photos"]);
        assert!(args.general.validate().is_err());

        // Failing: remote without sources
        let args = CliArgs::parse_from(["rclone-manager", "--send-to-remote", "Dropbox:"]);
        assert!(args.general.validate().is_err());

        // Passing: remote with sources
        let args = CliArgs::parse_from([
            "rclone-manager",
            "--send-to-remote",
            "Dropbox:",
            "/file.txt",
        ]);
        assert!(args.general.validate().is_ok());

        // Passing: remote, path, and sources
        let args = CliArgs::parse_from([
            "rclone-manager",
            "--send-to-remote",
            "Dropbox:",
            "--send-to-path",
            "/Photos",
            "/file.txt",
        ]);
        assert!(args.general.validate().is_ok());
    }
}
