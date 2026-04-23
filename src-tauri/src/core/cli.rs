//! CLI Arguments for `RClone` Manager
//!
//! This module contains the command-line argument definitions for
//! both Desktop and Headless (web-server) builds.

use clap::{Args, Parser};
use std::path::PathBuf;

/// `RClone` Manager CLI Arguments
#[derive(Parser, Debug, Clone)]
#[command(name = "rclone-manager")]
#[cfg_attr(feature = "web-server", command(about = "RClone Manager - Headless Web UI for Rclone", long_about = None))]
#[cfg_attr(not(feature = "web-server"), command(about = "RClone Manager - Desktop GUI for Rclone", long_about = None))]
pub struct CliArgs {
    #[command(flatten)]
    pub general: GeneralArgs,

    #[cfg(feature = "web-server")]
    #[command(flatten)]
    pub headless: HeadlessArgs,
}

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

    /// Start in system tray
    #[cfg(feature = "tray")]
    #[arg(long)]
    pub tray: bool,
}

/// Headless web server specific arguments
#[cfg(feature = "web-server")]
#[derive(Args, Debug, Clone)]
pub struct HeadlessArgs {
    /// Host address to bind to
    #[arg(
        short = 'H',
        long,
        env = "RCLONE_MANAGER_HOST",
        default_value = "0.0.0.0"
    )]
    pub host: String,

    /// Port to listen on
    #[arg(short, long, env = "RCLONE_MANAGER_PORT", default_value = "8080")]
    pub port: u16,

    /// Username for Basic Authentication (optional)
    #[arg(short, long, env = "RCLONE_MANAGER_USER")]
    pub user: Option<String>,

    /// Password for Basic Authentication (required if user is set)
    #[arg(long, env = "RCLONE_MANAGER_PASS")]
    pub pass: Option<String>,

    /// Path to TLS certificate file (optional)
    #[arg(long, env = "RCLONE_MANAGER_TLS_CERT")]
    pub tls_cert: Option<PathBuf>,

    /// Path to TLS key file (optional)
    #[arg(long, env = "RCLONE_MANAGER_TLS_KEY")]
    pub tls_key: Option<PathBuf>,
}

impl CliArgs {
    /// Validates the CLI arguments for logical consistency.
    pub fn validate(&self) -> Result<(), String> {
        #[cfg(feature = "web-server")]
        {
            // Auth validation: both user and pass must be present or both absent
            match (&self.headless.user, &self.headless.pass) {
                (Some(_), None) => {
                    return Err(
                        "Password is required when username is set (--pass or RCLONE_MANAGER_PASS)"
                            .into(),
                    );
                }
                (None, Some(_)) => {
                    return Err(
                        "Username is required when password is set (--user or RCLONE_MANAGER_USER)"
                            .into(),
                    );
                }
                _ => {}
            }

            // TLS validation: both cert and key must be present or both absent
            match (&self.headless.tls_cert, &self.headless.tls_key) {
                (Some(_), None) => {
                    return Err("TLS key is required when certificate is set (--tls-key or RCLONE_MANAGER_TLS_KEY)".into());
                }
                (None, Some(_)) => {
                    return Err("TLS certificate is required when key is set (--tls-cert or RCLONE_MANAGER_TLS_CERT)".into());
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Returns auth credentials if both user and pass are set
    #[cfg(feature = "web-server")]
    pub fn auth_credentials(&self) -> Option<(String, String)> {
        match (&self.headless.user, &self.headless.headless_pass()) {
            (Some(u), Some(p)) => Some((u.clone(), p.clone())),
            _ => None,
        }
    }
}

#[cfg(feature = "web-server")]
impl HeadlessArgs {
    /// Helper to get optional password
    pub fn headless_pass(&self) -> Option<String> {
        self.pass.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

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
        assert!(!args.general.tray);
    }

    #[test]
    fn test_tray_flag() {
        let args = CliArgs::parse_from(["rclone-manager", "--tray"]);
        assert!(args.general.tray);
    }

    #[cfg(feature = "web-server")]
    #[test]
    fn test_headless_defaults() {
        let args = CliArgs::parse_from(["rclone-manager"]);
        assert_eq!(args.headless.host, "0.0.0.0");
        assert_eq!(args.headless.port, 8080);
    }

    #[cfg(feature = "web-server")]
    #[test]
    fn test_validate_headless_auth() {
        let args = CliArgs::parse_from(["rclone-manager", "--user", "admin"]);
        assert!(args.validate().is_err());

        let args = CliArgs::parse_from(["rclone-manager", "--user", "admin", "--pass", "secret"]);
        assert!(args.validate().is_ok());
    }
}
