//! Native options; HTTP arguments exist only in the standalone server.
use crate::services::cli::GeneralArgs;
use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "rclone-manager",
    about = "RClone Manager - Desktop GUI for Rclone"
)]
pub(crate) struct CliArgs {
    #[command(flatten)]
    pub general: GeneralArgs,
    /// Start in system tray
    #[cfg(feature = "tray")]
    #[arg(long)]
    pub tray: bool,
}
impl CliArgs {
    /// `--tray`: start in the tray (hidden, and shown even if the setting is off).
    /// Builds without a tray never do. Used by the desktop window and the tray setup.
    #[cfg(desktop)]
    pub fn start_in_tray(&self) -> bool {
        #[cfg(feature = "tray")]
        {
            self.tray
        }
        #[cfg(not(feature = "tray"))]
        {
            false
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        self.general.validate()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
