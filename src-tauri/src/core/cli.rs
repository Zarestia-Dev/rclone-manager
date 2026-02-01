//! CLI Arguments for Web Server Mode
//!
//! This module contains the command-line argument definitions for
//! running RClone Manager in headless web server mode.

use clap::Parser;

/// RClone Manager - Headless Web Server Mode
#[derive(Parser, Debug, Clone)]
#[command(name = "rclone-manager")]
#[command(about = "RClone Manager headless web server", long_about = None)]
pub struct CliArgs {
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
    pub tls_cert: Option<std::path::PathBuf>,

    /// Path to TLS key file (optional)
    #[arg(long, env = "RCLONE_MANAGER_TLS_KEY")]
    pub tls_key: Option<std::path::PathBuf>,
}
