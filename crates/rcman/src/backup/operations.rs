//! Backup creation

use super::archive::{calculate_file_hash, create_rcman_container, create_zip_archive};
use super::types::*;
use crate::error::{Error, Result};
use crate::manager::SettingsManager;
use crate::storage::StorageBackend;
use chrono::Utc;
use log::{debug, info};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::RwLock;

/// Backup manager for creating and analyzing backups
pub struct BackupManager<'a, S: StorageBackend + 'static> {
    /// Reference to the settings manager
    pub(crate) manager: &'a SettingsManager<S>,

    /// Registered external config providers
    external_providers: Arc<RwLock<Vec<Box<dyn ExternalConfigProvider>>>>,
}

impl<'a, S: StorageBackend + 'static> BackupManager<'a, S> {
    /// Create a new backup manager
    pub fn new(manager: &'a SettingsManager<S>) -> Self {
        Self {
            manager,
            external_providers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Register an external config provider
    pub fn register_external_provider(&self, provider: Box<dyn ExternalConfigProvider>) {
        let mut providers = self.external_providers.write().unwrap();
        providers.push(provider);
    }

    /// Create a backup
    pub fn create(&self, options: BackupOptions) -> Result<PathBuf> {
        info!("📦 Creating backup with options: {:?}", options.export_type);

        // Validate password if provided (clone to avoid moving from options)
        let password = validate_password(options.password.clone())?;

        // Create temp directory for gathering files
        let temp_dir = tempfile::tempdir().map_err(|e| Error::BackupFailed(e.to_string()))?;
        let export_dir = temp_dir.path().join("export");
        fs::create_dir_all(&export_dir).map_err(|e| Error::DirectoryCreate {
            path: export_dir.display().to_string(),
            source: e,
        })?;

        // Gather files to backup
        let (contents, total_size) = self.gather_files(&export_dir, &options)?;

        // Create inner data archive
        let data_filename = "data.zip";
        let inner_archive_path = temp_dir.path().join(data_filename);

        create_zip_archive(
            &export_dir,
            &inner_archive_path,
            options.on_progress.clone(),
            total_size,
            password.as_deref(),
        )?;

        // Calculate checksum
        let (checksum, _) = calculate_file_hash(&inner_archive_path)?;

        // Create manifest
        let manifest = BackupManifest {
            version: 1,
            backup: BackupInfo {
                app_name: self.manager.config().app_name.clone(),
                app_version: self.manager.config().app_version.clone(),
                created_at: Utc::now(),
                export_type: options.export_type.clone(),
                encrypted: password.is_some(),
                user_note: options.user_note.clone(),
            },
            contents,

            integrity: BackupIntegrity {
                sha256: Some(checksum),
                size_bytes: total_size,
                compressed_size_bytes: fs::metadata(&inner_archive_path).ok().map(|m| m.len()),
            },
        };

        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| Error::BackupFailed(e.to_string()))?;

        // Generate output filename
        let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
        let filename = match &options.export_type {
            ExportType::Full => format!(
                "{}_{}_full.rcman",
                self.manager.config().app_name,
                timestamp
            ),
            ExportType::SettingsOnly => {
                format!(
                    "{}_{}_settings.rcman",
                    self.manager.config().app_name,
                    timestamp
                )
            }
            ExportType::Single { name, .. } => {
                format!(
                    "{}_{}_{}.rcman",
                    self.manager.config().app_name,
                    sanitize_filename(name),
                    timestamp
                )
            }
        };

        let output_path = options.output_dir.join(&filename);

        // Ensure output directory exists
        fs::create_dir_all(&options.output_dir).map_err(|e| Error::DirectoryCreate {
            path: options.output_dir.display().to_string(),
            source: e,
        })?;

        // Create final .rcman container
        create_rcman_container(
            &output_path,
            &manifest_json,
            &inner_archive_path,
            data_filename,
        )?;

        info!("✅ Backup created: {:?}", output_path);
        Ok(output_path)
    }

    /// Gather files to backup
    fn gather_files(
        &self,
        export_dir: &Path,
        options: &BackupOptions,
    ) -> Result<(BackupContents, u64)> {
        let mut contents = BackupContents::default();
        let mut total_size = 0u64;

        // 1. Main settings
        if !matches!(options.export_type, ExportType::Single { .. }) {
            let settings_path = self.manager.config().settings_path();
            if settings_path.exists() {
                let dest = export_dir.join("settings.json");
                fs::copy(&settings_path, &dest).map_err(|e| Error::FileRead {
                    path: settings_path.display().to_string(),
                    source: e,
                })?;
                total_size += fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                contents.settings = true;
                contents.file_count += 1;
                debug!("📄 Added main settings");
            }
        }

        // 2. Sub-settings
        let sub_settings_to_backup = match &options.export_type {
            ExportType::Full => options.include_sub_settings.clone(),
            ExportType::SettingsOnly => Vec::new(),
            ExportType::Single {
                settings_type,
                name,
            } => {
                // Handle single entry export
                if let Ok(sub) = self.manager.sub_settings(settings_type) {
                    let sub_export_dir = export_dir.join(settings_type);
                    fs::create_dir_all(&sub_export_dir).map_err(|e| Error::DirectoryCreate {
                        path: sub_export_dir.display().to_string(),
                        source: e,
                    })?;

                    let value = sub.get_value(name)?;
                    let dest = sub_export_dir.join(format!("{}.json", name));
                    let json = serde_json::to_string_pretty(&value)?;
                    fs::write(&dest, &json).map_err(|e| Error::FileWrite {
                        path: dest.display().to_string(),
                        source: e,
                    })?;
                    total_size += json.len() as u64;
                    contents.file_count += 1;
                    contents
                        .sub_settings
                        .insert(settings_type.clone(), vec![name.to_string()]);
                    debug!("📄 Added single entry: {}/{}", settings_type, name);
                }
                Vec::new() // Don't process further
            }
        };

        for sub_type in sub_settings_to_backup {
            if let Ok(sub) = self.manager.sub_settings(&sub_type) {
                let sub_export_dir = export_dir.join(&sub_type);
                fs::create_dir_all(&sub_export_dir).map_err(|e| Error::DirectoryCreate {
                    path: sub_export_dir.display().to_string(),
                    source: e,
                })?;

                for name in sub.list()? {
                    if let Ok(value) = sub.get_value(&name) {
                        let dest = sub_export_dir.join(format!("{}.json", name));
                        let json = serde_json::to_string_pretty(&value)?;
                        fs::write(&dest, &json).map_err(|e| Error::FileWrite {
                            path: dest.display().to_string(),
                            source: e,
                        })?;
                        total_size += json.len() as u64;
                        contents.file_count += 1;
                    }
                }

                contents.sub_settings.insert(sub_type.clone(), vec![]); // Empty vec means all items
                debug!("📄 Added sub-settings: {}", sub_type);
            }
        }

        // 3. External configs
        if !options.include_external_configs.is_empty()
            && !matches!(options.export_type, ExportType::Single { .. })
        {
            let providers = self.external_providers.read().unwrap();
            let external_dir = export_dir.join("external");

            for provider in providers.iter() {
                for config in provider.get_configs() {
                    if config.path.exists() {
                        fs::create_dir_all(&external_dir).map_err(|e| Error::DirectoryCreate {
                            path: external_dir.display().to_string(),
                            source: e,
                        })?;

                        let dest = external_dir.join(&config.id);
                        fs::copy(&config.path, &dest).map_err(|e| Error::FileRead {
                            path: config.path.display().to_string(),
                            source: e,
                        })?;

                        total_size += fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                        contents.file_count += 1;
                        contents.external_configs.push(config.id.clone());
                        debug!("📄 Added external config: {}", config.id);
                    }
                }
            }
        }

        Ok((contents, total_size))
    }

    /// Analyze a backup file
    pub fn analyze(&self, path: &Path) -> Result<BackupAnalysis> {
        if !path.exists() {
            return Err(Error::PathNotFound(path.display().to_string()));
        }

        // Read manifest from the .rcman file
        let manifest_bytes = super::archive::read_file_from_zip(path, "manifest.json")?;
        let manifest_str = String::from_utf8(manifest_bytes)
            .map_err(|e| Error::InvalidBackup(format!("Invalid manifest encoding: {}", e)))?;

        let manifest: BackupManifest = serde_json::from_str(&manifest_str)
            .map_err(|e| Error::InvalidBackup(format!("Invalid manifest JSON: {}", e)))?;

        let mut warnings = Vec::new();
        let mut is_valid = true;

        // Check manifest version compatibility
        if !super::types::is_manifest_version_supported(manifest.version) {
            warnings.push(format!(
                "Backup manifest version {} is not supported (supported: {}-{})",
                manifest.version,
                super::types::MANIFEST_VERSION_MIN_SUPPORTED,
                super::types::MANIFEST_VERSION_MAX_SUPPORTED
            ));
            is_valid = false;
        }

        // Check app version compatibility (warning only)
        if manifest.backup.app_version != self.manager.config().app_version {
            warnings.push(format!(
                "Backup was created with app version {}, current version is {}",
                manifest.backup.app_version,
                self.manager.config().app_version
            ));
        }

        // Verify encryption status by inspecting the actual data.zip
        let data_bytes = super::archive::read_file_from_zip(path, "data.zip")?;
        let temp_dir = tempfile::tempdir().map_err(|e| Error::BackupFailed(e.to_string()))?;
        let data_archive_path = temp_dir.path().join("data.zip");
        std::fs::write(&data_archive_path, data_bytes).map_err(|e| Error::FileWrite {
            path: data_archive_path.display().to_string(),
            source: e,
        })?;

        let data_encrypted = super::archive::is_zip_encrypted(&data_archive_path)?;

        // Warn if manifest and actual encryption status mismatch
        if manifest.backup.encrypted != data_encrypted {
            warnings.push(format!(
                "Manifest claims encrypted={}, but data.zip encrypted={}",
                manifest.backup.encrypted, data_encrypted
            ));
        }

        Ok(BackupAnalysis {
            is_valid,
            requires_password: data_encrypted,
            warnings,
            manifest,
        })
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Validate password (minimum length, no whitespace-only)
fn validate_password(password: Option<String>) -> Result<Option<String>> {
    match password {
        Some(p) if p.trim().is_empty() => Err(Error::BackupFailed(
            "Password cannot be empty or whitespace-only".into(),
        )),
        Some(p) if p.len() < 4 => Err(Error::BackupFailed(
            "Password must be at least 4 characters".into(),
        )),
        other => Ok(other),
    }
}

/// Sanitize filename for safe file system usage
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect()
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SettingsConfig;
    use crate::storage::JsonStorage;
    use crate::sub_settings::SubSettingsConfig;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn test_create_full_backup() {
        let temp = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: temp.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test-app".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager = SettingsManager::new(config).unwrap();

        // Create some settings
        fs::write(
            temp.path().join("settings.json"),
            r#"{"general": {"theme": "dark"}}"#,
        )
        .unwrap();

        // Register and populate sub-settings
        manager.register_sub_settings(SubSettingsConfig::new("profiles"));
        let profiles = manager.sub_settings("profiles").unwrap();
        profiles
            .set("default", &json!({"name": "Default"}))
            .unwrap();

        // Create backup
        let backup_dir = temp.path().join("backups");
        let backup = manager.backup();
        let backup_path = backup
            .create(BackupOptions {
                output_dir: backup_dir.clone(),
                export_type: ExportType::Full,
                include_sub_settings: vec!["profiles".into()],
                ..Default::default()
            })
            .unwrap();

        assert!(backup_path.exists());
        assert!(backup_path.extension().unwrap() == "rcman");
    }

    #[test]
    fn test_analyze_backup() {
        let temp = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: temp.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test-app".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager = SettingsManager::new(config).unwrap();

        // Create minimal backup
        fs::write(temp.path().join("settings.json"), "{}").unwrap();

        let backup = manager.backup();
        let backup_path = backup
            .create(BackupOptions {
                output_dir: temp.path().join("backups"),
                export_type: ExportType::SettingsOnly,
                ..Default::default()
            })
            .unwrap();

        // Analyze it
        let analysis = backup.analyze(&backup_path).unwrap();
        assert!(analysis.is_valid);
        assert!(!analysis.requires_password);
        assert_eq!(analysis.manifest.backup.app_name, "test-app");
    }

    #[test]
    fn test_validate_password() {
        assert!(validate_password(None).unwrap().is_none());
        assert!(validate_password(Some("valid".into())).unwrap().is_some());
        assert!(validate_password(Some("   ".into())).is_err());
        assert!(validate_password(Some("abc".into())).is_err()); // Too short
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("normal"), "normal");
        assert_eq!(sanitize_filename("with/slash"), "with_slash");
        assert_eq!(sanitize_filename("file:name"), "file_name");
    }
}
