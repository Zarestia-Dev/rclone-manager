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

impl CliArgs {
    /// Validates the CLI arguments for logical consistency.
    ///
    /// Returns an error if:
    /// - `user` is set but `pass` is not
    /// - `pass` is set but `user` is not
    /// - `tls_cert` is set but `tls_key` is not
    /// - `tls_key` is set but `tls_cert` is not
    pub fn validate(&self) -> Result<(), String> {
        // Auth validation: both user and pass must be present or both absent
        match (&self.user, &self.pass) {
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
        match (&self.tls_cert, &self.tls_key) {
            (Some(_), None) => {
                return Err("TLS key is required when certificate is set (--tls-key or RCLONE_MANAGER_TLS_KEY)".into());
            }
            (None, Some(_)) => {
                return Err("TLS certificate is required when key is set (--tls-cert or RCLONE_MANAGER_TLS_CERT)".into());
            }
            _ => {}
        }

        Ok(())
    }

    /// Returns auth credentials if both user and pass are set
    pub fn auth_credentials(&self) -> Option<(String, String)> {
        match (&self.user, &self.pass) {
            (Some(u), Some(p)) => Some((u.clone(), p.clone())),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    // =========================================================================
    // CLI Argument Parsing Tests
    // =========================================================================

    #[test]
    fn test_default_values() {
        let args = CliArgs::parse_from(["rclone-manager"]);
        assert_eq!(args.host, "0.0.0.0");
        assert_eq!(args.port, 8080);
        assert!(args.user.is_none());
        assert!(args.pass.is_none());
        assert!(args.tls_cert.is_none());
        assert!(args.tls_key.is_none());
    }

    #[test]
    fn test_custom_host_and_port() {
        let args = CliArgs::parse_from(["rclone-manager", "--host", "127.0.0.1", "--port", "9000"]);
        assert_eq!(args.host, "127.0.0.1");
        assert_eq!(args.port, 9000);
    }

    #[test]
    fn test_short_host_flag() {
        let args = CliArgs::parse_from(["rclone-manager", "-H", "192.168.1.1"]);
        assert_eq!(args.host, "192.168.1.1");
    }

    #[test]
    fn test_short_port_flag() {
        let args = CliArgs::parse_from(["rclone-manager", "-p", "3000"]);
        assert_eq!(args.port, 3000);
    }

    #[test]
    fn test_auth_flags() {
        let args = CliArgs::parse_from(["rclone-manager", "--user", "admin", "--pass", "secret"]);
        assert_eq!(args.user, Some("admin".to_string()));
        assert_eq!(args.pass, Some("secret".to_string()));
    }

    #[test]
    fn test_tls_flags() {
        let args = CliArgs::parse_from([
            "rclone-manager",
            "--tls-cert",
            "/path/to/cert.pem",
            "--tls-key",
            "/path/to/key.pem",
        ]);
        assert_eq!(
            args.tls_cert,
            Some(std::path::PathBuf::from("/path/to/cert.pem"))
        );
        assert_eq!(
            args.tls_key,
            Some(std::path::PathBuf::from("/path/to/key.pem"))
        );
    }

    // =========================================================================
    // Auth Validation Tests
    // =========================================================================

    #[test]
    fn test_validate_auth_both_set() {
        let args = CliArgs::parse_from(["rclone-manager", "--user", "admin", "--pass", "secret"]);
        assert!(args.validate().is_ok());
    }

    #[test]
    fn test_validate_auth_none_set() {
        let args = CliArgs::parse_from(["rclone-manager"]);
        assert!(args.validate().is_ok());
    }

    #[test]
    fn test_validate_auth_user_only() {
        let args = CliArgs::parse_from(["rclone-manager", "--user", "admin"]);
        let result = args.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Password is required"));
    }

    #[test]
    fn test_validate_auth_pass_only() {
        let args = CliArgs::parse_from(["rclone-manager", "--pass", "secret"]);
        let result = args.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Username is required"));
    }

    // =========================================================================
    // TLS Validation Tests
    // =========================================================================

    #[test]
    fn test_validate_tls_both_set() {
        let args = CliArgs::parse_from([
            "rclone-manager",
            "--tls-cert",
            "/cert.pem",
            "--tls-key",
            "/key.pem",
        ]);
        assert!(args.validate().is_ok());
    }

    #[test]
    fn test_validate_tls_none_set() {
        let args = CliArgs::parse_from(["rclone-manager"]);
        assert!(args.validate().is_ok());
    }

    #[test]
    fn test_validate_tls_cert_only() {
        let args = CliArgs::parse_from(["rclone-manager", "--tls-cert", "/cert.pem"]);
        let result = args.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("TLS key is required"));
    }

    #[test]
    fn test_validate_tls_key_only() {
        let args = CliArgs::parse_from(["rclone-manager", "--tls-key", "/key.pem"]);
        let result = args.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("TLS certificate is required"));
    }

    // =========================================================================
    // Auth Credentials Helper Tests
    // =========================================================================

    #[test]
    fn test_auth_credentials_both_set() {
        let args = CliArgs::parse_from(["rclone-manager", "--user", "admin", "--pass", "secret"]);
        let creds = args.auth_credentials();
        assert!(creds.is_some());
        let (user, pass) = creds.unwrap();
        assert_eq!(user, "admin");
        assert_eq!(pass, "secret");
    }

    #[test]
    fn test_auth_credentials_none_set() {
        let args = CliArgs::parse_from(["rclone-manager"]);
        assert!(args.auth_credentials().is_none());
    }

    #[test]
    fn test_auth_credentials_partial() {
        let args = CliArgs::parse_from(["rclone-manager", "--user", "admin"]);
        assert!(args.auth_credentials().is_none());
    }
}
