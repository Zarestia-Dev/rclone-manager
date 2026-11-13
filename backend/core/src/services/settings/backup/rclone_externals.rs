//! External configs supplied per export or restore.
//!
//! The rclone config and remote definitions live outside rcman's managed settings,
//! so each operation passes them to rcman as its own `ExternalConfig`.

use rcman::backup::ExternalConfig;
use std::path::PathBuf;

const RCLONE_CONF_ID: &str = "rclone.conf";
/// The id archives used before `RCLONE_CONF_ID`.
const LEGACY_RCLONE_CONF_ID: &str = "rclone_config";
const REMOTE_ID_PREFIX: &str = "remote:";

/// Whether an archive's external config id names the whole rclone config.
pub(super) fn is_rclone_conf_id(id: &str) -> bool {
    matches!(id, RCLONE_CONF_ID | LEGACY_RCLONE_CONF_ID)
}

/// The name of the remote an external config id carries, if it is a remote definition.
pub(super) fn remote_name(id: &str) -> Option<&str> {
    id.strip_prefix(REMOTE_ID_PREFIX)
}

fn remote_archive_filename(name: &str) -> String {
    format!("{name}_rclone.json")
}

/// The rclone config file, for export.
pub(super) fn rclone_conf(path: PathBuf) -> ExternalConfig {
    ExternalConfig::new(RCLONE_CONF_ID, path)
        .display_name("Rclone Configuration")
        .description("The main rclone configuration file")
        .sensitive()
}

/// Both ids an archive's rclone config may carry, restored to `path`.
pub(super) fn rclone_conf_targets(path: PathBuf) -> [ExternalConfig; 2] {
    [
        rclone_conf(path.clone()),
        ExternalConfig::new(LEGACY_RCLONE_CONF_ID, path).sensitive(),
    ]
}

/// One remote's definition from rclone's `config/dump`, for export.
pub(super) fn remote_definition(
    name: &str,
    config: &serde_json::Value,
) -> Result<ExternalConfig, serde_json::Error> {
    let content = serde_json::to_vec_pretty(&serde_json::json!({ name: config }))?;
    Ok(ExternalConfig::from_content(
        format!("{REMOTE_ID_PREFIX}{name}"),
        remote_archive_filename(name),
        content,
    )
    .display_name(format!("{name} Rclone Config"))
    .description(format!("Rclone configuration for remote '{name}'"))
    .sensitive())
}

/// A remote definition in an archive. Importing it needs rclone's async API, so
/// the restore hands the content back instead of writing it.
pub(super) fn deferred_remote(id: &str) -> ExternalConfig {
    let name = remote_name(id).unwrap_or(id);
    ExternalConfig::from_content(id, remote_archive_filename(name), Vec::new())
        .import_deferred()
        .sensitive()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcman::backup::{ExportSource, ImportTarget};

    #[test]
    fn both_rclone_conf_ids_are_recognised() {
        assert!(is_rclone_conf_id("rclone.conf"));
        assert!(is_rclone_conf_id("rclone_config"));
        assert!(!is_rclone_conf_id("remote:drive"));
        assert!(!is_rclone_conf_id(""));
    }

    #[test]
    fn remote_ids_carry_the_remote_name() {
        assert_eq!(remote_name("remote:drive"), Some("drive"));
        assert_eq!(remote_name("remote:my:drive"), Some("my:drive"));
        assert_eq!(remote_name("rclone.conf"), None);
    }

    #[test]
    fn restore_targets_write_both_ids_to_the_destination_config() {
        let path = PathBuf::from("target.conf");
        let configs = rclone_conf_targets(path.clone());
        assert_eq!(
            configs.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["rclone.conf", "rclone_config"]
        );
        for config in configs {
            assert!(config.is_sensitive);
            assert!(matches!(config.import_target, ImportTarget::File(target) if target == path));
        }
    }

    #[test]
    fn a_remote_definition_wraps_the_config_under_the_remote_name() {
        let config = remote_definition("drive", &serde_json::json!({"token": "t"})).unwrap();
        assert_eq!(config.id, "remote:drive");
        assert_eq!(config.archive_filename, "drive_rclone.json");
        assert!(config.is_sensitive);
        let ExportSource::Content(bytes) = config.export_source else {
            panic!("a remote definition exports in-memory content");
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["drive"]["token"], "t");
    }

    #[test]
    fn a_remote_restore_target_defers_to_the_caller() {
        let config = deferred_remote("remote:drive");
        assert_eq!(config.id, "remote:drive");
        assert_eq!(config.archive_filename, "drive_rclone.json");
        assert!(matches!(config.import_target, ImportTarget::Deferred));
    }
}
