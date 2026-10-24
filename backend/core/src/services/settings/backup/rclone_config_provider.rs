//! Dynamic Rclone configuration provider for backup
//!
//! Provides specific remote configs from the cache for granular exports.

use rcman::backup::{ExternalConfig, ExternalConfigProvider};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

/// Provider for Rclone configuration
///
/// Supports both file-based (rclone.conf) and specific remote exports.
#[derive(Clone, Default)]
pub struct RcloneConfigProvider {
    configs: Arc<RwLock<Vec<ExternalConfig>>>,
}

impl RcloneConfigProvider {
    /// Replace the operation snapshot without accumulating stale providers.
    /// Callers serialize export, restore and vault operations before replacing it.
    pub(super) fn replace(&self, snapshot: Self) {
        *self
            .configs
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot.get_configs();
    }

    /// Resolve both current and legacy archive IDs to the target config path.
    pub(super) fn for_restore(path: PathBuf) -> Self {
        let provider = Self::from_path(path.clone());
        provider
            .configs
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(ExternalConfig::new("rclone_config", path).sensitive());
        provider
    }

    /// Create provider for the raw rclone.conf file
    pub fn from_path(path: PathBuf) -> Self {
        let config = ExternalConfig::new("rclone.conf", path)
            .display_name("Rclone Configuration")
            .description("The main rclone configuration file")
            .sensitive();

        Self {
            configs: Arc::new(RwLock::new(vec![config])),
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
                    format!("remote:{remote_name}"),
                    format!("{remote_name}_rclone.json"),
                    content,
                )
                .display_name(format!("{remote_name} Rclone Config"))
                .description(format!("Rclone configuration for remote '{remote_name}'"))
                .sensitive()
                .import_read_only(),
            ]
        } else {
            vec![]
        };

        Ok(Self {
            configs: Arc::new(RwLock::new(configs)),
        })
    }
}

impl ExternalConfigProvider for RcloneConfigProvider {
    fn get_configs(&self) -> Vec<ExternalConfig> {
        self.configs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_updates_registered_clone_without_retaining_remote_secrets() {
        let provider = RcloneConfigProvider::default();
        let registered = provider.clone();
        provider.replace(
            RcloneConfigProvider::for_remote("drive", Some(serde_json::json!({"token": "old"})))
                .unwrap(),
        );
        assert_eq!(registered.get_configs()[0].id, "remote:drive");
        provider.replace(RcloneConfigProvider::default());
        assert!(registered.get_configs().is_empty());
    }

    #[test]
    fn restore_aliases_use_the_destination_config() {
        let path = PathBuf::from("target.conf");
        let configs = RcloneConfigProvider::for_restore(path.clone()).get_configs();
        assert_eq!(
            configs.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["rclone.conf", "rclone_config"]
        );
        for config in configs {
            assert!(
                matches!(config.import_target, rcman::backup::ImportTarget::File(target) if target == path)
            );
        }
    }
}
