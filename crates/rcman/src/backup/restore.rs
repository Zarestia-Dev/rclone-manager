//! Restore functionality

use super::archive::{extract_zip_archive, read_file_from_zip};
use super::types::*;
use crate::error::{Error, Result};
use crate::storage::StorageBackend;
use log::{debug, info, warn};
use std::fs;
use std::path::Path;

impl<'a, S: StorageBackend + 'static> super::BackupManager<'a, S> {
    /// Restore from a backup
    pub fn restore(&self, options: RestoreOptions) -> Result<RestoreResult> {
        let mode_str = if options.dry_run { "[DRY RUN] " } else { "" };
        info!(
            "{}📦 Restoring from backup: {:?}",
            mode_str, options.backup_path
        );

        // Analyze the backup first
        let analysis = self.analyze(&options.backup_path)?;

        // Check manifest version compatibility
        if !analysis.is_valid {
            return Err(Error::InvalidBackup(format!(
                "Backup manifest version {} is not supported (supported: {}-{})",
                analysis.manifest.version,
                super::types::MANIFEST_VERSION_MIN_SUPPORTED,
                super::types::MANIFEST_VERSION_MAX_SUPPORTED
            )));
        }

        // Check password requirement
        if analysis.requires_password && options.password.is_none() {
            return Err(Error::PasswordRequired);
        }

        // Create temp directory for extraction
        let temp_dir = tempfile::tempdir().map_err(|e| Error::RestoreFailed(e.to_string()))?;
        let extract_dir = temp_dir.path().join("extracted");

        // Extract the inner data archive
        let data_filename = "data.zip";
        let data_bytes = read_file_from_zip(&options.backup_path, data_filename)?;

        let data_archive_path = temp_dir.path().join(data_filename);
        fs::write(&data_archive_path, &data_bytes).map_err(|e| Error::FileWrite {
            path: data_archive_path.display().to_string(),
            source: e,
        })?;

        // Verify checksum if requested and available
        let mut result = RestoreResult {
            is_dry_run: options.dry_run,
            ..Default::default()
        };

        if options.verify_checksum {
            if let Some(ref expected_checksum) = analysis.manifest.integrity.sha256 {
                let (actual_checksum, _) = super::archive::calculate_file_hash(&data_archive_path)?;
                let is_valid = &actual_checksum == expected_checksum;
                result.checksum_valid = Some(is_valid);

                if !is_valid {
                    warn!(
                        "⚠️ Checksum mismatch! Expected: {}, Got: {}",
                        expected_checksum, actual_checksum
                    );
                    return Err(Error::InvalidBackup(
                        "Data archive checksum verification failed - backup may be corrupted"
                            .into(),
                    ));
                }
                debug!("✅ Checksum verified: {}", actual_checksum);
            } else {
                debug!("ℹ️ No checksum in manifest, skipping verification");
            }
        }

        // Extract data archive (always zip now)
        extract_zip_archive(
            &data_archive_path,
            &extract_dir,
            options.password.as_deref(),
        )?;

        // 1. Restore main settings
        if options.restore_settings && analysis.manifest.contents.settings {
            let settings_src = extract_dir.join("settings.json");
            if settings_src.exists() {
                let settings_dest = self.manager.config().settings_path();

                if settings_dest.exists() && !options.overwrite_existing {
                    result.skipped.push("settings.json".into());
                    warn!(
                        "{}⚠️ Skipping settings.json (exists, overwrite disabled)",
                        mode_str
                    );
                } else if options.dry_run {
                    result.restored.push("settings.json".into());
                    debug!("{}📋 Would restore settings.json", mode_str);
                } else {
                    fs::copy(&settings_src, &settings_dest).map_err(|e| Error::FileWrite {
                        path: settings_dest.display().to_string(),
                        source: e,
                    })?;
                    result.restored.push("settings.json".into());
                    debug!("✅ Restored settings.json");
                }
            }
        }

        // 2. Restore sub-settings
        let sub_settings_to_restore = if options.restore_sub_settings.is_empty() {
            analysis.manifest.contents.sub_settings.clone()
        } else {
            options.restore_sub_settings.clone()
        };

        for (sub_type, items_filter) in sub_settings_to_restore {
            let sub_src_dir = extract_dir.join(&sub_type);
            if !sub_src_dir.exists() {
                continue;
            }

            // Get sub-settings handler
            let sub = match self.manager.sub_settings(&sub_type) {
                Ok(s) => s,
                Err(_) => {
                    warn!(
                        "⚠️ Sub-settings type '{}' not registered, skipping",
                        sub_type
                    );
                    continue;
                }
            };

            // Iterate through files in the backup
            for entry in fs::read_dir(&sub_src_dir).map_err(|e| Error::FileRead {
                path: sub_src_dir.display().to_string(),
                source: e,
            })? {
                let entry = entry.map_err(|e| Error::FileRead {
                    path: sub_src_dir.display().to_string(),
                    source: e,
                })?;

                let file_name = entry.file_name();
                let name_str = file_name.to_string_lossy();

                if !name_str.ends_with(".json") {
                    continue;
                }

                let entry_name = name_str.trim_end_matches(".json");

                // Filter by items if specified
                if !items_filter.is_empty() && !items_filter.contains(&entry_name.to_string()) {
                    continue;
                }

                let entry_id = format!("{}/{}", sub_type, entry_name);

                // Check if exists
                if !options.overwrite_existing && sub.exists(entry_name)? {
                    result.skipped.push(entry_id);
                    continue;
                }

                if options.dry_run {
                    result.restored.push(entry_id.clone());
                    debug!("{}📋 Would restore {}", mode_str, entry_id);
                    continue;
                }

                // Load and save
                let content = fs::read_to_string(entry.path()).map_err(|e| Error::FileRead {
                    path: entry.path().display().to_string(),
                    source: e,
                })?;

                let value: serde_json::Value = serde_json::from_str(&content)?;
                sub.set(entry_name, &value)?;

                result.restored.push(entry_id.clone());
                debug!("✅ Restored {}", entry_id);
            }
        }

        // 3. Restore external configs (if any requested)
        if !options.restore_external_configs.is_empty() || options.restore_sub_settings.is_empty() {
            let external_dir = extract_dir.join("external");
            if external_dir.exists() {
                for config_name in &analysis.manifest.contents.external_configs {
                    // Skip if specific configs requested and this isn't one
                    if !options.restore_external_configs.is_empty()
                        && !options.restore_external_configs.contains(config_name)
                    {
                        continue;
                    }

                    let src = external_dir.join(config_name);
                    if src.exists() {
                        // External configs need to be handled by the application
                        // We just track them here
                        result.external_pending.push(config_name.clone());
                    }
                }
            }
        }

        info!(
            "✅ Restore complete: {} restored, {} skipped",
            result.restored.len(),
            result.skipped.len()
        );

        Ok(result)
    }

    /// Get the path to an external config from a backup (for manual restoration)
    pub fn get_external_config_from_backup(
        &self,
        backup_path: &Path,
        config_name: &str,
        password: Option<&str>,
    ) -> Result<Vec<u8>> {
        let _analysis = self.analyze(backup_path)?;
        let data_filename = "data.zip";

        // Extract the data archive temporarily
        let temp_dir = tempfile::tempdir().map_err(|e| Error::RestoreFailed(e.to_string()))?;
        let data_bytes = read_file_from_zip(backup_path, data_filename)?;
        let data_archive_path = temp_dir.path().join(data_filename);
        fs::write(&data_archive_path, data_bytes).map_err(|e| Error::FileWrite {
            path: data_archive_path.display().to_string(),
            source: e,
        })?;

        let extract_dir = temp_dir.path().join("extracted");

        // Extract (always zip now)
        extract_zip_archive(&data_archive_path, &extract_dir, password)?;

        let config_path = extract_dir.join("external").join(config_name);
        fs::read(&config_path).map_err(|e| Error::FileRead {
            path: config_path.display().to_string(),
            source: e,
        })
    }
}

/// Result of a restore operation
#[derive(Debug, Default)]
pub struct RestoreResult {
    /// Items that were restored
    pub restored: Vec<String>,

    /// Items that were skipped (already exist)
    pub skipped: Vec<String>,

    /// External configs that need manual handling
    pub external_pending: Vec<String>,

    /// Whether this was a dry run (no actual changes made)
    pub is_dry_run: bool,

    /// Whether the checksum was verified successfully
    pub checksum_valid: Option<bool>,
}

impl RestoreResult {
    /// Check if anything was restored
    pub fn has_changes(&self) -> bool {
        !self.restored.is_empty()
    }

    /// Get total item count
    pub fn total(&self) -> usize {
        self.restored.len() + self.skipped.len()
    }

    /// Would this restore have made changes (for dry run results)
    pub fn would_change(&self) -> bool {
        !self.restored.is_empty() || self.checksum_valid == Some(false)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SettingsConfig;
    use crate::manager::SettingsManager;
    use crate::storage::JsonStorage;
    use crate::sub_settings::SubSettingsConfig;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn test_backup_and_restore_roundtrip() {
        let temp = tempdir().unwrap();

        // Setup manager with settings and sub-settings
        let config = SettingsConfig {
            config_dir: temp.path().join("config"),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        fs::create_dir_all(&config.config_dir).unwrap();
        fs::write(
            config.config_dir.join("settings.json"),
            r#"{"test": {"value": 42}}"#,
        )
        .unwrap();

        let manager = SettingsManager::new(config).unwrap();
        manager.register_sub_settings(SubSettingsConfig::new("items"));

        let items = manager.sub_settings("items").unwrap();
        items.set("item1", &json!({"name": "First"})).unwrap();

        // Create backup
        let backup = manager.backup();
        let backup_path = backup
            .create(BackupOptions {
                output_dir: temp.path().join("backups"),
                include_sub_settings: vec!["items".into()],
                ..Default::default()
            })
            .unwrap();

        // Setup fresh manager (simulating a new installation)
        let temp2 = tempdir().unwrap();
        let config2 = SettingsConfig {
            config_dir: temp2.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager2 = SettingsManager::new(config2).unwrap();
        manager2.register_sub_settings(SubSettingsConfig::new("items"));

        // Restore
        let result = manager2
            .backup()
            .restore(RestoreOptions {
                backup_path,
                restore_settings: true,
                ..Default::default()
            })
            .unwrap();

        assert!(result.has_changes());
        assert!(result.restored.contains(&"settings.json".to_string()));
        assert!(result.restored.contains(&"items/item1".to_string()));

        // Verify restored data
        let items2 = manager2.sub_settings("items").unwrap();
        let loaded = items2.get_value("item1").unwrap();
        assert_eq!(loaded["name"], json!("First"));
    }

    #[test]
    fn test_restore_skip_existing() {
        let temp = tempdir().unwrap();

        // Create a backup with some data
        let config = SettingsConfig {
            config_dir: temp.path().join("config"),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        fs::create_dir_all(&config.config_dir).unwrap();
        fs::write(config.config_dir.join("settings.json"), "{}").unwrap();

        let manager = SettingsManager::new(config).unwrap();
        let backup_path = manager
            .backup()
            .create(BackupOptions {
                output_dir: temp.path().join("backups"),
                ..Default::default()
            })
            .unwrap();

        // Restore with overwrite disabled (settings already exist)
        let result = manager
            .backup()
            .restore(RestoreOptions {
                backup_path,
                overwrite_existing: false,
                ..Default::default()
            })
            .unwrap();

        // Should be skipped since it already exists
        assert!(result.skipped.contains(&"settings.json".to_string()));
    }
}
