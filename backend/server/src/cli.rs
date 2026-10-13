//! HTTP options shared by the standalone server and native tray host.
use clap::{Args, Parser};
use rclone_manager_core::services::cli::GeneralArgs;
use std::path::PathBuf;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "rclone-manager-server",
    about = "RClone Manager - Headless Web UI for Rclone"
)]
pub(crate) struct CliArgs {
    #[command(flatten)]
    pub general: GeneralArgs,
    #[command(flatten)]
    pub headless: HttpArgs,
}
impl CliArgs {
    pub fn validate(&self) -> Result<(), String> {
        self.general.validate()?;
        self.headless.validate()
    }
}

/// Headless web server specific arguments
#[derive(Args, Debug, Clone)]
pub struct HttpArgs {
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

impl HttpArgs {
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
    #[test]
    fn test_headless_full_args() {
        let args = CliArgs::parse_from([
            "rclone-manager",
            "--host",
            "127.0.0.1",
            "--port",
            "9090",
            "--user",
            "hakan",
            "--pass",
            "secret",
            "--tls-cert",
            "/path/to/cert",
            "--tls-key",
            "/path/to/key",
        ]);
        assert_eq!(args.headless.host, "127.0.0.1");
        assert_eq!(args.headless.port, 9090);
        assert_eq!(args.headless.user, Some("hakan".to_string()));
        assert_eq!(args.headless.pass, Some("secret".to_string()));
        assert_eq!(args.headless.tls_cert, Some(PathBuf::from("/path/to/cert")));
        assert_eq!(args.headless.tls_key, Some(PathBuf::from("/path/to/key")));
        assert!(args.validate().is_ok());
    }

    #[test]
    fn test_validate_headless_tls() {
        let args = CliArgs::parse_from(["rclone-manager", "--tls-cert", "/path/to/cert"]);
        assert!(args.validate().is_err());

        let args = CliArgs::parse_from(["rclone-manager", "--tls-key", "/path/to/key"]);
        assert!(args.validate().is_err());

        let args = CliArgs::parse_from([
            "rclone-manager",
            "--tls-cert",
            "/path/to/cert",
            "--tls-key",
            "/path/to/key",
        ]);
        assert!(args.validate().is_ok());
    }

    #[test]
    fn rejects_native_flags_and_invalid_authentication() {
        assert!(CliArgs::try_parse_from(["server", "--tray"]).is_err());
        for flag in ["--user", "--pass"] {
            assert!(
                CliArgs::try_parse_from(["server", flag, "value"])
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let args =
            CliArgs::try_parse_from(["server", "--user", "name", "--pass", "secret"]).unwrap();
        assert!(args.validate().is_ok());
        assert_eq!(
            args.headless.auth_credentials(),
            Some(("name".into(), "secret".into()))
        );
    }
}
