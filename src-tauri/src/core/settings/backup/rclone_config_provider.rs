//! Dynamic Rclone configuration provider for backup
//!
//! Provides specific remote configs from the cache for granular exports.

use rcman::backup::{ExternalConfig, ExternalConfigProvider};
use std::path::PathBuf;

/// Provider for Rclone configuration
///
/// Supports both file-based (rclone.conf) and specific remote exports.
pub struct RcloneConfigProvider {
    configs: Vec<ExternalConfig>,
}

impl RcloneConfigProvider {
    /// Create provider for the raw rclone.conf file
    pub fn from_path(path: PathBuf) -> Self {
        let config = ExternalConfig::new("rclone.conf", path)
            .display_name("Rclone Configuration")
            .description("The main rclone configuration file")
            .sensitive();

        Self {
            configs: vec![config],
        }
    }

    /// Create provider for a specific remote
    ///
    /// Takes the config data directly (already fetched from cache)
    pub fn for_remote(
        remote_name: &str,
        remote_config: Option<serde_json::Value>,
    ) -> Result<Self, serde_json::Error> {
        let configs = if let Some(config) = remote_config {
            // Wrap in object with remote name as key for consistency
            let wrapped = serde_json::json!({
                remote_name: config
            });
            let content = serde_json::to_vec_pretty(&wrapped)?;

            vec![
                ExternalConfig::from_content(
                    format!("remote:{}", remote_name),
                    format!("{}_rclone.json", remote_name),
                    content,
                )
                .display_name(format!("{} Rclone Config", remote_name))
                .description(format!("Rclone configuration for remote '{}'", remote_name))
                .sensitive()
                .import_read_only(),
            ]
        } else {
            vec![]
        };

        Ok(Self { configs })
    }
}

impl ExternalConfigProvider for RcloneConfigProvider {
    fn get_configs(&self) -> Vec<ExternalConfig> {
        self.configs.clone()
    }
}
