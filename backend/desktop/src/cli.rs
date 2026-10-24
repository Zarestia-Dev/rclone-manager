//! Native options; HTTP arguments exist only in the tray/server application.
use crate::services::cli::GeneralArgs;
use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[cfg_attr(
    feature = "web-server",
    command(
        name = "rclone-manager-headless",
        about = "RClone Manager - Headless Web UI for Rclone"
    )
)]
#[cfg_attr(
    not(feature = "web-server"),
    command(
        name = "rclone-manager",
        about = "RClone Manager - Desktop GUI for Rclone"
    )
)]
pub(crate) struct CliArgs {
    #[command(flatten)]
    pub general: GeneralArgs,
    /// Start in system tray
    #[cfg(feature = "tray")]
    #[arg(long)]
    pub tray: bool,
    #[cfg(feature = "web-server")]
    #[command(flatten)]
    pub headless: rclone_manager_server::HttpArgs,
}
impl CliArgs {
    pub fn validate(&self) -> Result<(), String> {
        self.general.validate()?;
        #[cfg(feature = "web-server")]
        self.headless.validate()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(feature = "web-server"))]
    #[test]
    fn desktop_does_not_accept_http_options() {
        for flag in [
            "--host",
            "--port",
            "--user",
            "--pass",
            "--tls-cert",
            "--tls-key",
        ] {
            assert!(CliArgs::try_parse_from(["app", flag, "value"]).is_err());
        }
        assert!(CliArgs::try_parse_from(["app"]).unwrap().validate().is_ok());
    }
    #[cfg(feature = "web-server")]
    #[test]
    fn tray_server_parses_http_options() {
        let args =
            CliArgs::try_parse_from(["app", "--host", "127.0.0.1", "--port", "9090"]).unwrap();
        assert_eq!(args.headless.port, 9090);
        assert_eq!(args.headless.host, "127.0.0.1");
    }
}
