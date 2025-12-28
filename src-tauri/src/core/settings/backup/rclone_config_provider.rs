//! Dynamic Rclone configuration provider for backup
//!
//! Provides specific remote configs from the cache for granular exports.

use rcman::{ExternalConfig, ExternalConfigProvider};

/// Provider for Rclone configuration (full or specific remote)
///
/// The config data is captured at construction time (in async context)
/// to avoid blocking issues.
pub struct RcloneConfigProvider {
    /// Pre-fetched configs for use in sync get_configs()
    configs: Vec<ExternalConfig>,
}

impl RcloneConfigProvider {
    /// Create provider for a specific remote
    ///
    /// Takes the config data directly (already fetched from cache)
    pub fn for_remote(remote_name: &str, remote_config: Option<serde_json::Value>) -> Self {
        let configs = if let Some(config) = remote_config {
            // Wrap in object with remote name as key for consistency
            let wrapped = serde_json::json!({
                remote_name: config
            });

            let json_bytes = serde_json::to_vec_pretty(&wrapped).unwrap_or_default();

            vec![
                ExternalConfig::from_content(
                    format!("remote:{}", remote_name),
                    format!("{}_rclone.json", remote_name),
                    json_bytes,
                )
                .display_name(format!("{} Rclone Config", remote_name))
                .description(format!("Rclone configuration for remote '{}'", remote_name))
                .sensitive()
                .import_read_only(),
            ]
        } else {
            vec![]
        };

        Self { configs }
    }

    /// Create provider for full config dump
    #[allow(dead_code)]
    pub fn full(all_configs: serde_json::Value) -> Self {
        let json_bytes = serde_json::to_vec_pretty(&all_configs).unwrap_or_default();
        let configs = vec![
            ExternalConfig::from_content("rclone_dump", "rclone_config.json", json_bytes)
                .display_name("Full Rclone Config")
                .description("Complete Rclone configuration dump")
                .sensitive()
                .import_read_only(),
        ];

        Self { configs }
    }
}

impl ExternalConfigProvider for RcloneConfigProvider {
    fn get_configs(&self) -> Vec<ExternalConfig> {
        // Return pre-fetched configs (no async needed)
        self.configs.clone()
    }
}
