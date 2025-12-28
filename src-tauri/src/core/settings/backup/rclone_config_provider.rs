use rcman::{ExternalConfig, ExternalConfigProvider};
use std::path::PathBuf;

/// Provider for Rclone configuration file
pub struct RcloneConfigProvider {
    /// Configured path from settings (if any)
    config_path: String,
    /// Default rclone config path (e.g. ~/.config/rclone/rclone.conf)
    default_path: PathBuf,
}

impl RcloneConfigProvider {
    pub fn new(config_path: String, default_path: PathBuf) -> Self {
        Self {
            config_path,
            default_path,
        }
    }

    /// Resolve the rclone config path
    fn resolve_path(&self) -> PathBuf {
        if !self.config_path.is_empty() {
            return PathBuf::from(&self.config_path);
        }

        self.default_path.clone()
    }
}

impl ExternalConfigProvider for RcloneConfigProvider {
    fn get_configs(&self) -> Vec<ExternalConfig> {
        let path = self.resolve_path();

        // Only return if it exists (or maybe always return so backup system knows about it?)
        // rcman checks existence before copy, but we can verify here too.
        if !path.exists() {
            return vec![];
        }

        vec![
            ExternalConfig::new("rclone_config", path)
                .display_name("Rclone Configuration")
                .description("Main Rclone configuration file (rclone.conf)")
                .sensitive() // Contains remote credentials
                .optional(),
        ] // Optional in backup
    }
}
