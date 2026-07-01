//! Backup/restore logic

use super::archive::{extract_zip_archive, read_file_from_zip};
use crate::config::SettingsSchema;
use crate::error::{Error, Result};
use crate::storage::StorageBackend;
use crate::utils::sync::RwLockExt;

use crate::backup::BackupAnalysis;
#[cfg(feature = "profiles")]
use crate::backup::SubSettingsManifestEntry;

use crate::RestoreOptions;
use log::{debug, info, warn};
use std::fs;
use std::path::Path;

#[cfg(feature = "profiles")]
use crate::profiles::PROFILES_DIR;

impl<S: StorageBackend + 'static, Schema: SettingsSchema> super::BackupManager<'_, S, Schema> {
    /// Restore from a backup
    ///
    /// # Arguments
    ///
    /// * `options` - The restore options
    ///
    /// # Returns
    ///
    /// Returns a `RestoreResult` containing the result of the restore operation.
    ///
    /// # Errors
    ///
    /// Returns an error if the backup cannot be read or the restore operation fails.
    pub fn restore(&self, options: &RestoreOptions) -> Result<RestoreResult> {
        let mode_str = if options.flags.control.dry_run {
            "[DRY RUN] "
        } else {
            ""
        };
        info!(
            "{mode_str} Restoring from backup: {:?}",
            options.backup_path.display()
        );

        // Analyze the backup first
        let analysis = self.analyze(&options.backup_path)?;

        // Check manifest version compatibility
        if !analysis.is_valid {
            return Err(Error::InvalidBackup(format!(
                "{}: Backup manifest version {} is not supported (supported: {}-{})",
                options.backup_path.display(),
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
            path: data_archive_path.clone(),
            source: e,
        })?;

        // Verify checksum if requested and available
        let mut result = RestoreResult {
            is_dry_run: options.flags.control.dry_run,
            ..Default::default()
        };

        if options.flags.control.verify_checksum {
            if let Some(ref expected_checksum) = analysis.manifest.integrity.sha256 {
                let (actual_checksum, _) = super::archive::calculate_file_hash(&data_archive_path)?;
                let is_valid = &actual_checksum == expected_checksum;
                result.checksum_valid = Some(is_valid);

                if !is_valid {
                    warn!(
                        "Checksum mismatch! Expected: {expected_checksum}, Got: {actual_checksum}"
                    );
                    return Err(Error::InvalidBackup(format!(
                        "{}: Data archive checksum verification failed - backup may be corrupted",
                        options.backup_path.display()
                    )));
                }
                debug!("Checksum verified: {actual_checksum}");
            } else {
                debug!("No checksum in manifest, skipping verification");
            }
        }

        // Extract data archive (always zip now)
        extract_zip_archive(
            &data_archive_path,
            &extract_dir,
            options.password.as_deref(),
        )?;

        // Create context
        let ctx = RestoreContext {
            manager: self,
            options,
            extract_dir: &extract_dir,
            analysis: &analysis,
            mode_str,
        };

        // Restore main settings
        ctx.restore_main_settings(&mut result)?;

        // Restore sub-settings
        ctx.restore_sub_settings_entries(&mut result)?;

        // Restore external configs
        ctx.restore_external_configs_entries(&mut result)?;

        info!(
            "Restore complete: {} restored, {} skipped",
            result.restored.len(),
            result.skipped.len()
        );

        Ok(result)
    }

    /// Get the path to an external config from a backup (for manual restoration)
    ///
    /// # Arguments
    ///
    /// * `backup_path` - The path to the backup file
    /// * `config_name` - The name of the external config to restore
    /// * `password` - The password for the backup file (if encrypted)
    ///
    /// # Returns
    ///
    /// Returns a vector of bytes containing the external config data.
    ///
    /// # Errors
    ///
    /// Returns an error if the backup cannot be read or the external config cannot be restored.
    pub fn get_external_config_from_backup(
        &self,
        backup_path: &Path,
        config_name: &str,
        password: Option<&str>,
    ) -> Result<Vec<u8>> {
        let analysis = self.analyze(backup_path)?;
        let data_filename = "data.zip";

        // Extract the data archive temporarily
        let temp_dir = tempfile::tempdir().map_err(|e| Error::RestoreFailed(e.to_string()))?;
        let data_bytes = read_file_from_zip(backup_path, data_filename)?;
        let data_archive_path = temp_dir.path().join(data_filename);
        fs::write(&data_archive_path, data_bytes).map_err(|e| Error::FileWrite {
            path: data_archive_path.clone(),
            source: e,
        })?;

        let extract_dir = temp_dir.path().join("extracted");

        // Extract (always zip now)
        extract_zip_archive(&data_archive_path, &extract_dir, password)?;

        let external_dir = extract_dir.join("external");

        let mut candidate_filenames = Vec::new();
        if let Some(file_name) = analysis
            .manifest
            .contents
            .external_config_files
            .get(config_name)
            .cloned()
        {
            candidate_filenames.push(file_name);
        }
        if let Some(config) = self.resolve_external_config(config_name) {
            candidate_filenames.push(config.archive_filename);
        }
        candidate_filenames.push(config_name.to_string());
        candidate_filenames.dedup();

        for filename in candidate_filenames {
            let config_path = external_dir.join(&filename);
            if config_path.exists() {
                return fs::read(&config_path).map_err(|e| Error::FileRead {
                    path: config_path,
                    source: e,
                });
            }
        }

        Err(Error::PathNotFound(
            external_dir.join(config_name).display().to_string(),
        ))
    }

    /// Helper to resolve external config from ID using registered providers
    fn resolve_external_config(&self, id: &str) -> Option<super::types::ExternalConfig> {
        // Check static configs in settings first
        if let Some(cfg) = self
            .manager
            .config()
            .external_configs
            .iter()
            .find(|c| c.id == id)
        {
            return Some(cfg.clone());
        }

        // Check dynamic providers
        {
            let providers = self.manager.external_providers.read_recovered().ok()?;
            for provider in providers.iter() {
                for cfg in provider.get_configs() {
                    if cfg.id == id {
                        return Some(cfg);
                    }
                }
            }
        }

        None
    }
}

struct RestoreContext<'a, S: StorageBackend + 'static, Schema: SettingsSchema> {
    manager: &'a super::BackupManager<'a, S, Schema>,
    options: &'a RestoreOptions,
    extract_dir: &'a Path,
    analysis: &'a BackupAnalysis,
    mode_str: &'a str,
}

/// Helper context for sub-settings operations to reduce argument count
struct SubSettingsContext<'a, S: StorageBackend> {
    sub_type: &'a str,
    items_filter: &'a [String],
    sub: &'a crate::sub_settings::SubSettings<S>,
}

impl<S: StorageBackend + 'static, Schema: SettingsSchema> RestoreContext<'_, S, Schema> {
    fn restore_main_settings(&self, result: &mut RestoreResult) -> Result<()> {
        if !self.options.flags.scope.restore_settings {
            return Ok(());
        }

        // Logic for profiles
        #[cfg(feature = "profiles")]
        if self.manager.manager.config().profiles_enabled {
            return self.restore_main_settings_profiles(result);
        }

        // Logic for legacy flat settings (either profiles disabled or feature off)
        if self.analysis.manifest.contents.settings {
            // Try to load settings from backup (agnostic of extension)
            if let Some((mut value, _ext)) = load_settings_agnostic(
                self.extract_dir,
                "settings",
                self.manager.manager.storage(),
            )? {
                let settings_dest = self.manager.manager.config().settings_path();
                let dest_filename = settings_dest
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();

                if settings_dest.exists() && !self.options.flags.control.overwrite_existing {
                    result
                        .add_skipped(dest_filename.to_string(), RestoreSkipReason::ExistsConflict);
                    warn!(
                        "{} Skipping {} (exists, overwrite disabled)",
                        self.mode_str, dest_filename
                    );
                } else if self.options.flags.control.dry_run {
                    result.restored.push(dest_filename.to_string());
                    debug!("{} Would restore {}", self.mode_str, dest_filename);
                } else {
                    self.hydrate_main_settings_secrets(&mut value, None);

                    // Write using the configured storage backend (handles conversion!)
                    self.manager
                        .manager
                        .storage()
                        .write(&settings_dest, &value)?;
                    result.restored.push(dest_filename.to_string());
                    debug!("Restored {dest_filename}");
                }
            }
        }

        Ok(())
    }

    #[cfg(feature = "profiles")]
    fn restore_main_settings_profiles(&self, result: &mut RestoreResult) -> Result<()> {
        let config = self.manager.manager.config();

        // Restore .profiles.{ext}
        let ext = self.manager.manager.storage().extension();
        let manifest_filename = format!(".profiles.{ext}");
        let profiles_manifest = self.extract_dir.join(&manifest_filename);
        let target_manifest = config.config_dir.join(&manifest_filename);

        if profiles_manifest.exists() {
            if target_manifest.exists() && !self.options.flags.control.overwrite_existing {
                result.add_skipped(manifest_filename.clone(), RestoreSkipReason::ExistsConflict);
                warn!("{} Skipping {} (exists)", self.mode_str, manifest_filename);
            } else if self.options.flags.control.dry_run {
                result.restored.push(manifest_filename.clone());
                debug!("{} Would restore {}", self.mode_str, manifest_filename);
            } else {
                fs::copy(&profiles_manifest, &target_manifest).map_err(|e| Error::FileWrite {
                    path: target_manifest.clone(),
                    source: e,
                })?;
                result.restored.push(manifest_filename);
            }
        }

        // Restore profiles
        let profiles_src_dir = self.extract_dir.join(PROFILES_DIR);
        if profiles_src_dir.exists() {
            let target_profiles_dir = config.config_dir.join(PROFILES_DIR);

            // Handle single profile restore request
            let profiles_to_restore = if let Some(ref profile) = self.options.restore_profile {
                vec![profile.clone()]
            } else {
                // Restore all found in source
                crate::error::read_dir(&profiles_src_dir)?
                    .filter_map(std::result::Result::ok)
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            };

            for profile_name in profiles_to_restore {
                let src_profile_path = profiles_src_dir.join(&profile_name);
                if !src_profile_path.exists() {
                    warn!(
                        "{} Profile '{profile_name}' not found in backup",
                        self.mode_str
                    );
                    continue;
                }

                // Determine target profile name (rename if requested)
                let target_profile_name = if self.options.restore_profile.is_some() {
                    self.options
                        .restore_profile_as
                        .as_ref()
                        .unwrap_or(&profile_name)
                        .clone()
                } else {
                    profile_name.clone()
                };

                let target_profile_path = target_profiles_dir.join(&target_profile_name);
                crate::utils::security::ensure_secure_dir(&target_profile_path)?;

                let target_settings_file = &self.manager.manager.config().settings_file;
                let dest_settings = target_profile_path.join(target_settings_file);
                let restore_id = format!("profiles/{target_profile_name}/{target_settings_file}");

                if let Some((value, _ext)) = load_settings_agnostic(
                    &src_profile_path,
                    "settings",
                    self.manager.manager.storage(),
                )? {
                    let mut value = value;

                    if dest_settings.exists() && !self.options.flags.control.overwrite_existing {
                        result.add_skipped(restore_id, RestoreSkipReason::ExistsConflict);
                    } else if self.options.flags.control.dry_run {
                        result.restored.push(restore_id);
                        debug!(
                            "{} Would restore settings for profile {target_profile_name}",
                            self.mode_str
                        );
                    } else {
                        self.hydrate_main_settings_secrets(
                            &mut value,
                            Some(target_profile_name.as_str()),
                        );

                        self.manager
                            .manager
                            .storage()
                            .write(&dest_settings, &value)?;
                        result.restored.push(restore_id);
                        debug!("Restored settings for profile {target_profile_name}");
                    }
                }
            }
        }
        Ok(())
    }

    fn restore_sub_settings_entries(&self, result: &mut RestoreResult) -> Result<()> {
        let sub_settings_to_restore = if self.options.restore_sub_settings.is_empty() {
            // Convert manifest entries to basic HashMap for processing
            self.analysis.manifest.contents.sub_settings_list()
        } else {
            self.options.restore_sub_settings.clone()
        };

        for (sub_type, items_filter) in sub_settings_to_restore {
            let sub_src_dir = self.extract_dir.join(&sub_type);

            // Get sub-settings handler
            let Ok(sub) = self.manager.manager.sub_settings(&sub_type) else {
                warn!("Sub-settings type '{sub_type}' not registered, skipping");
                result.add_skipped(sub_type, RestoreSkipReason::UnregisteredSubSettingsType);
                continue;
            };

            let sub_ctx = SubSettingsContext {
                sub_type: &sub_type,
                items_filter: &items_filter,
                sub: sub.as_ref(),
            };

            // Check if we are dealing with a profiled backup for this entry
            #[cfg(feature = "profiles")]
            let is_profiled_backup = matches!(
                self.analysis.manifest.contents.sub_settings.get(&sub_type),
                Some(SubSettingsManifestEntry::Profiled { .. })
            );
            #[cfg(not(feature = "profiles"))]
            let is_profiled_backup = false;

            if is_profiled_backup {
                #[cfg(feature = "profiles")]
                self.restore_profiled_sub_settings(&sub_ctx, &sub_src_dir, result)?;
            } else {
                self.restore_flat_sub_settings(&sub_ctx, &sub_src_dir, result)?;
            }
        }
        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn hydrate_main_settings_secrets(&self, value: &mut serde_json::Value, profile: Option<&str>) {
        let Some(creds) = self.manager.manager.credentials() else {
            return;
        };

        let mut hydrated_count = 0u32;

        for (full_key, meta) in self
            .manager
            .manager
            .schema_metadata()
            .iter()
            .filter(|(_, meta)| meta.is_secret())
        {
            let Some(setting_value) = crate::utils::value::get_path(value, full_key) else {
                continue;
            };

            if setting_value.is_null() {
                continue;
            }

            if *setting_value == meta.default {
                if let Err(err) = creds.remove_with_profile(full_key, profile) {
                    warn!(
                        "Failed to clear credential for restored default secret {full_key}: {err}"
                    );
                } else {
                    crate::utils::value::remove_path(value, full_key);
                }
                continue;
            }

            let secret_value = match setting_value {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };

            if let Err(err) = creds.store_with_profile(full_key, &secret_value, profile) {
                warn!(
                    "Failed to rehydrate secret {full_key} into credential storage during restore: {err}"
                );
                continue;
            }

            crate::utils::value::remove_path(value, full_key);
            hydrated_count += 1;
        }

        if hydrated_count > 0 {
            debug!(
                "Rehydrated {hydrated_count} secret credential(s) during restore for profile {profile:?}"
            );
        }
    }

    #[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
    fn hydrate_main_settings_secrets(
        &self,
        _value: &mut serde_json::Value,
        _profile: Option<&str>,
    ) {
    }

    fn restore_flat_sub_settings(
        &self,
        sub_ctx: &SubSettingsContext<S>,
        sub_src_dir: &Path,
        result: &mut RestoreResult,
    ) -> Result<()> {
        let ext = sub_ctx.sub.extension();
        let sub_single_file_src = self
            .extract_dir
            .join(format!("{}.{}", sub_ctx.sub_type, ext));

        // Collect entries to restore from either directory or single file
        let mut entries_to_restore: Vec<(String, serde_json::Value)> = Vec::new();

        if sub_single_file_src.exists() {
            // Restore from single file
            let content =
                fs::read_to_string(&sub_single_file_src).map_err(|e| Error::FileRead {
                    path: sub_single_file_src.clone(),
                    source: e,
                })?;

            let file_data: serde_json::Value = self
                .manager
                .manager
                .storage()
                .deserialize(&content)
                .map_err(|e| Error::Parse(e.to_string()))?;

            if let Some(obj) = file_data.as_object() {
                for (key, value) in obj {
                    entries_to_restore.push((key.clone(), value.clone()));
                }
            }
        } else if sub_src_dir.exists() {
            // Restore from directory
            for entry in crate::error::read_dir(sub_src_dir)? {
                let entry = entry.map_err(|e| Error::FileRead {
                    path: sub_src_dir.to_path_buf(),
                    source: e,
                })?;

                let file_name = entry.file_name();
                let name_str = file_name.to_string_lossy();
                let ext_str = format!(".{ext}");

                if !name_str.ends_with(&ext_str) {
                    continue;
                }

                let entry_name = name_str.trim_end_matches(&ext_str).to_string();

                let content = fs::read_to_string(entry.path()).map_err(|e| Error::FileRead {
                    path: entry.path(),
                    source: e,
                })?;

                let value: serde_json::Value =
                    self.manager.manager.storage().deserialize(&content)?;

                // If this is the main file for a SingleFile sub-setting (e.g. connections.json inside connections/),
                // flatten its entries so we restore "Local" and "Remote" instead of "connections" -> {...}
                if sub_ctx.sub.is_single_file() && entry_name == sub_ctx.sub_type {
                    if let serde_json::Value::Object(map) = value {
                        entries_to_restore.extend(map);
                    }
                } else {
                    entries_to_restore.push((entry_name, value));
                }
            }
        }

        // Process the collected entries
        for (entry_name, value) in entries_to_restore {
            // Filter by items if specified
            if !sub_ctx.items_filter.is_empty() && !sub_ctx.items_filter.contains(&entry_name) {
                continue;
            }

            let entry_id = format!("{}/{}", sub_ctx.sub_type, entry_name);

            // Check if exists
            if !self.options.flags.control.overwrite_existing && sub_ctx.sub.exists(&entry_name)? {
                result.add_skipped(entry_id, RestoreSkipReason::ExistsConflict);
                continue;
            }

            if self.options.flags.control.dry_run {
                result.restored.push(entry_id.clone());
                debug!("{} Would restore {entry_id}", self.mode_str);
                continue;
            }

            sub_ctx.sub.set(&entry_name, &value)?;

            result.restored.push(entry_id.clone());
            debug!("Restored {entry_id}");
        }
        Ok(())
    }

    #[cfg(feature = "profiles")]
    fn restore_profiled_sub_settings(
        &self,
        sub_ctx: &SubSettingsContext<S>,
        sub_src_dir: &Path,
        result: &mut RestoreResult,
    ) -> Result<()> {
        let target_profiles_enabled = sub_ctx.sub.profiles_enabled();

        // Restore .profiles.{ext} if target supports it
        if target_profiles_enabled {
            #[cfg(feature = "profiles")]
            let ext = sub_ctx.sub.storage().extension();
            #[cfg(not(feature = "profiles"))]
            let ext = "json"; // fallback

            let manifest_filename = format!(".profiles.{ext}");
            let profiles_manifest = sub_src_dir.join(&manifest_filename);
            let target_root = sub_ctx.sub.root_path();
            let target_manifest = target_root.join(&manifest_filename);

            if profiles_manifest.exists() {
                if target_manifest.exists() && !self.options.flags.control.overwrite_existing {
                    // Skip
                } else if !self.options.flags.control.dry_run {
                    fs::create_dir_all(&target_root).ok();
                    fs::copy(&profiles_manifest, &target_manifest).ok();
                }
            }

            // Iterate profiles
            let profiles_src_dir = sub_src_dir.join(PROFILES_DIR);

            if profiles_src_dir.exists() {
                let profiles_to_restore = if let Some(ref profile) = self.options.restore_profile {
                    vec![profile.clone()]
                } else {
                    crate::error::read_dir(&profiles_src_dir)?
                        .filter_map(std::result::Result::ok)
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect()
                };

                for profile_name in profiles_to_restore {
                    self.restore_single_profile_sub_setting(
                        sub_ctx,
                        &profiles_src_dir,
                        &profile_name,
                        result,
                    )?;
                }
            }
        } else {
            // Profiled backup -> Flat target?
            // If specific profile requested, we can flatten it to root.
            if let Some(ref src_profile) = self.options.restore_profile {
                let profiles_src_dir = sub_src_dir.join(PROFILES_DIR);
                let src_profile_path = profiles_src_dir.join(src_profile);

                if src_profile_path.exists() {
                    self.restore_flattened_profile_content(sub_ctx, &src_profile_path, result)?;
                }
            } else {
                warn!(
                    "Cannot restore profiled backup of '{}' to non-profiled target without specifying --restore-profile",
                    sub_ctx.sub_type
                );
                result.add_pending(
                    sub_ctx.sub_type,
                    RestorePendingReason::ProfileSelectionRequired,
                );
            }
        }
        Ok(())
    }

    #[cfg(feature = "profiles")]
    fn restore_single_profile_sub_setting(
        &self,
        sub_ctx: &SubSettingsContext<S>,
        profiles_src_dir: &Path,
        profile_name: &str,
        result: &mut RestoreResult,
    ) -> Result<()> {
        let src_profile_path = profiles_src_dir.join(profile_name);
        if !src_profile_path.exists() {
            result.add_pending(
                format!("{}/{profile_name}", sub_ctx.sub_type),
                RestorePendingReason::MissingSourceProfile,
            );
            return Ok(());
        }

        let target_root = sub_ctx.sub.root_path();
        let target_profiles_dir = target_root.join(PROFILES_DIR);

        let target_profile_name = if self.options.restore_profile.is_some() {
            self.options
                .restore_profile_as
                .as_ref()
                .unwrap_or(&profile_name.to_string())
                .clone()
        } else {
            profile_name.to_string()
        };

        let dest_profile_path = target_profiles_dir.join(&target_profile_name);

        // Restore content of profile (SingleFile or MultiFile)
        if let Ok(entries) = fs::read_dir(&src_profile_path) {
            let ext = sub_ctx.sub.extension();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some(ext) {
                    let file_name = entry.file_name();
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();

                    // Filter items
                    if !sub_ctx.items_filter.is_empty() && !sub_ctx.items_filter.contains(&stem) {
                        continue;
                    }

                    // Target file
                    let dest = dest_profile_path.join(&file_name);

                    if dest.exists() && !self.options.flags.control.overwrite_existing {
                        result
                            .skipped
                            .push(format!("{}/{target_profile_name}/{stem}", sub_ctx.sub_type));
                    } else if self.options.flags.control.dry_run {
                        result
                            .restored
                            .push(format!("{}/{target_profile_name}/{stem}", sub_ctx.sub_type));
                        debug!(
                            "{} Would restore {stem} to profile {target_profile_name}",
                            self.mode_str
                        );
                    } else {
                        fs::create_dir_all(&dest_profile_path).map_err(|e| {
                            Error::DirectoryCreate {
                                path: dest_profile_path.clone(),
                                source: e,
                            }
                        })?;

                        fs::copy(&path, &dest).map_err(|e| Error::FileWrite {
                            path: dest.clone(),
                            source: e,
                        })?;
                        result
                            .restored
                            .push(format!("{}/{target_profile_name}/{stem}", sub_ctx.sub_type));
                        debug!("Restored {stem} to profile {target_profile_name}");
                    }
                }
            }
        }
        Ok(())
    }

    #[cfg(feature = "profiles")]
    fn restore_flattened_profile_content(
        &self,
        sub_ctx: &SubSettingsContext<S>,
        src_profile_path: &Path,
        result: &mut RestoreResult,
    ) -> Result<()> {
        // Restore items from this profile to active flat root
        if let Ok(entries) = fs::read_dir(src_profile_path) {
            let ext = sub_ctx.sub.extension();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some(ext) {
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if !sub_ctx.items_filter.is_empty() && !sub_ctx.items_filter.contains(&stem) {
                        continue;
                    }

                    let content = fs::read_to_string(&path).map_err(|e| Error::FileRead {
                        path: path.clone(),
                        source: e,
                    })?;
                    let value: serde_json::Value =
                        self.manager.manager.storage().deserialize(&content)?;

                    // Handle SingleFile sub-settings being restored from a profile containing the single file
                    if sub_ctx.sub.is_single_file() && stem == sub_ctx.sub_type {
                        if let serde_json::Value::Object(map) = value {
                            for (k, v) in map {
                                let item_id = format!("{}/{k}", sub_ctx.sub_type);

                                if sub_ctx.sub.exists(&k)?
                                    && !self.options.flags.control.overwrite_existing
                                {
                                    result.add_skipped(item_id, RestoreSkipReason::ExistsConflict);
                                } else if self.options.flags.control.dry_run {
                                    result.restored.push(item_id.clone());
                                    debug!("{} Would restore flattened {item_id}", self.mode_str);
                                } else {
                                    sub_ctx.sub.set(&k, &v)?;
                                    result.restored.push(item_id.clone());
                                    debug!("Restored flattened {item_id}");
                                }
                            }
                        }
                        continue;
                    }

                    let entry_id = format!("{}/{stem}", sub_ctx.sub_type);

                    if sub_ctx.sub.exists(&stem)? && !self.options.flags.control.overwrite_existing
                    {
                        result.add_skipped(entry_id, RestoreSkipReason::ExistsConflict);
                    } else if self.options.flags.control.dry_run {
                        result.restored.push(entry_id.clone());
                        debug!("{} Would restore flattened {entry_id}", self.mode_str);
                    } else {
                        sub_ctx.sub.set(&stem, &value)?;
                        result.restored.push(entry_id.clone());
                        debug!("Restored flattened {entry_id}");
                    }
                }
            }
        }
        Ok(())
    }

    fn restore_external_configs_entries(&self, result: &mut RestoreResult) -> Result<()> {
        let external_dir = self.extract_dir.join("external");
        if external_dir.exists() {
            for config_name in &self.analysis.manifest.contents.external_configs {
                // Skip if specific configs requested and this isn't one
                if !self.options.restore_external_configs.is_empty()
                    && !self.options.restore_external_configs.contains(config_name)
                {
                    continue;
                }

                let archive_filename = match self
                    .analysis
                    .manifest
                    .contents
                    .external_config_files
                    .get(config_name)
                {
                    Some(file_name) => file_name.as_str(),
                    None => config_name,
                };

                self.restore_single_external_config(
                    config_name,
                    archive_filename,
                    &external_dir,
                    result,
                )?;
            }
        }
        Ok(())
    }

    fn restore_single_external_config(
        &self,
        config_name: &str,
        archive_filename: &str,
        external_dir: &Path,
        result: &mut RestoreResult,
    ) -> Result<()> {
        if let Some(external_config) = self.manager.resolve_external_config(config_name) {
            let data = Self::read_external_backup_data(
                external_dir,
                config_name,
                archive_filename,
                &external_config.archive_filename,
            )?;

            // Handle different import targets
            match &external_config.import_target {
                super::types::ImportTarget::ReadOnly => {
                    debug!("Skipping read-only external config: {config_name}");
                    result.add_skipped(
                        config_name.to_string(),
                        RestoreSkipReason::ReadOnlyImportTarget,
                    );
                }
                super::types::ImportTarget::File(dest_path) => {
                    if dest_path.exists() && !self.options.flags.control.overwrite_existing {
                        result.add_skipped(
                            config_name.to_string(),
                            RestoreSkipReason::ExistsConflict,
                        );
                        debug!("{} Skipping external {config_name} (exists)", self.mode_str);
                    } else if self.options.flags.control.dry_run {
                        result.restored.push(config_name.to_string());
                        debug!("{} Would restore external {config_name}", self.mode_str);
                    } else {
                        if let Some(parent) = dest_path.parent() {
                            fs::create_dir_all(parent).map_err(|e| Error::FileWrite {
                                path: parent.to_path_buf(),
                                source: e,
                            })?;
                        }
                        fs::write(dest_path, &data).map_err(|e| Error::FileWrite {
                            path: dest_path.clone(),
                            source: e,
                        })?;
                        result.restored.push(config_name.to_string());
                        debug!("Restored external {config_name}");
                    }
                }
                super::types::ImportTarget::Command { program, args } => {
                    if self.options.flags.control.dry_run {
                        result.restored.push(config_name.to_string());
                        debug!("{} Would pipe to command: {program}", self.mode_str);
                    } else {
                        use std::io::Write;
                        use std::process::{Command, Stdio};

                        let mut child = Command::new(program)
                            .args(args)
                            .stdin(Stdio::piped())
                            .spawn()
                            .map_err(|e| {
                                Error::BackupFailed(format!(
                                    "Failed to spawn command '{program}': {e}"
                                ))
                            })?;

                        if let Some(mut stdin) = child.stdin.take() {
                            stdin.write_all(&data).map_err(|e| {
                                Error::BackupFailed(format!(
                                    "Failed to write to command stdin: {e}"
                                ))
                            })?;
                        }

                        let status = child.wait().map_err(|e| {
                            Error::BackupFailed(format!("Command '{program}' failed: {e}"))
                        })?;

                        if !status.success() {
                            return Err(Error::BackupFailed(format!(
                                "Command '{program}' exited with code {:?}",
                                status.code()
                            )));
                        }

                        result.restored.push(config_name.to_string());
                        debug!("Restored external {config_name} via command");
                    }
                }
                super::types::ImportTarget::Handler(handler) => {
                    if self.options.flags.control.dry_run {
                        result.restored.push(config_name.to_string());
                        debug!(
                            "{} Would call custom handler for {config_name}",
                            self.mode_str
                        );
                    } else {
                        handler(&data)?;
                        result.restored.push(config_name.to_string());
                        debug!("Restored external {config_name} via handler");
                    }
                }
            }
        } else {
            result.add_pending(
                config_name.to_string(),
                RestorePendingReason::UnknownExternalConfig,
            );
            warn!("Unknown external config ID: {config_name}, requires manual restore");
        }
        Ok(())
    }

    fn read_external_backup_data(
        external_dir: &Path,
        config_name: &str,
        archive_filename: &str,
        fallback_archive_filename: &str,
    ) -> Result<Vec<u8>> {
        let mut candidate_filenames = vec![archive_filename.to_string()];
        candidate_filenames.push(fallback_archive_filename.to_string());
        candidate_filenames.push(config_name.to_string());
        candidate_filenames.dedup();

        let mut last_candidate_path = None;
        for filename in candidate_filenames {
            let src = external_dir.join(filename);
            last_candidate_path = Some(src.clone());
            if src.exists() {
                return fs::read(&src).map_err(|e| Error::FileRead {
                    path: src,
                    source: e,
                });
            }
        }

        Err(Error::PathNotFound(
            last_candidate_path
                .unwrap_or_else(|| external_dir.join(config_name))
                .display()
                .to_string(),
        ))
    }
}

/// Attempt to load settings from a file, trying generic extensions
fn load_settings_agnostic<S: StorageBackend>(
    dir: &Path,
    stem: &str,
    storage: &S,
) -> Result<Option<(serde_json::Value, String)>> {
    // Try configured storage extension
    let current_ext = storage.extension();
    let current_path = dir.join(format!("{stem}.{current_ext}"));
    if current_path.exists() {
        let content = fs::read_to_string(&current_path).map_err(|e| Error::FileRead {
            path: current_path.clone(),
            source: e,
        })?;
        // Try deserializing using storage backend first
        // If it fails, maybe try generic? But usually if extension matches, format should match.
        // We map deserialize error to generic Parse error
        // Note: we need explicit type annotation for deserialize
        let val: serde_json::Value = storage.deserialize(&content)?;
        return Ok(Some((val, current_ext.to_string())));
    }

    // 1. Try JSON (Fallback)
    if current_ext != "json" {
        let json_path = dir.join(format!("{stem}.json"));
        if json_path.exists() {
            let content = fs::read_to_string(&json_path).map_err(|e| Error::FileRead {
                path: json_path.clone(),
                source: e,
            })?;
            let val: serde_json::Value =
                serde_json::from_str(&content).map_err(|e| Error::Parse(e.to_string()))?;
            return Ok(Some((val, "json".to_string())));
        }
    }

    // 2. Try TOML (if enabled)
    #[cfg(feature = "toml")]
    {
        let toml_path = dir.join(format!("{stem}.toml"));
        if toml_path.exists() {
            let content = fs::read_to_string(&toml_path).map_err(|e| Error::FileRead {
                path: toml_path.clone(),
                source: e,
            })?;
            // toml deserializes into serde_json::Value via Serde
            let val: serde_json::Value =
                toml::from_str(&content).map_err(|e| Error::Parse(e.to_string()))?;
            return Ok(Some((val, "toml".to_string())));
        }
    }

    Ok(None)
}

/// Result of a restore operation
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum RestoreSkipReason {
    /// Target entry already exists and overwrite is disabled.
    ExistsConflict,
    /// External config import target is read-only.
    ReadOnlyImportTarget,
    /// Requested sub-settings type was not registered in target manager.
    UnregisteredSubSettingsType,
}

/// Detailed skipped restore item with reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreSkippedItem {
    /// Item identifier (same value as in `RestoreResult::skipped`).
    pub id: String,
    /// Why this item was skipped.
    pub reason: RestoreSkipReason,
}

/// Pending restore reasons that require manual handling or missing source data.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum RestorePendingReason {
    /// External config is present in backup but not registered in target.
    UnknownExternalConfig,
    /// Profiled backup requires selecting a source profile for flat targets.
    ProfileSelectionRequired,
    /// Requested source profile was not present in backup contents.
    MissingSourceProfile,
}

/// Detailed pending restore item with reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorePendingItem {
    /// Item identifier (same value as in `RestoreResult::external_pending`).
    pub id: String,
    /// Why this item is pending.
    pub reason: RestorePendingReason,
}

#[derive(Debug, Default)]
pub struct RestoreResult {
    /// Items that were restored
    pub restored: Vec<String>,

    /// Items that were skipped (already exist)
    pub skipped: Vec<String>,

    /// Detailed skip records with reason for conflict visibility.
    pub skipped_details: Vec<RestoreSkippedItem>,

    /// External configs that need manual handling
    pub external_pending: Vec<String>,

    /// Detailed pending records with reason for manual handling visibility.
    pub pending_details: Vec<RestorePendingItem>,

    /// Whether this was a dry run (no actual changes made)
    pub is_dry_run: bool,

    /// Whether the checksum was verified successfully
    pub checksum_valid: Option<bool>,
}

impl RestoreResult {
    fn add_skipped(&mut self, id: impl Into<String>, reason: RestoreSkipReason) {
        let id = id.into();
        self.skipped.push(id.clone());
        self.skipped_details.push(RestoreSkippedItem { id, reason });
    }

    fn add_pending(&mut self, id: impl Into<String>, reason: RestorePendingReason) {
        let id = id.into();
        self.external_pending.push(id.clone());
        self.pending_details.push(RestorePendingItem { id, reason });
    }

    /// Check if anything was restored
    #[must_use]
    pub fn has_changes(&self) -> bool {
        !self.restored.is_empty()
    }

    /// Check if restore had any skipped or pending conflicts.
    #[must_use]
    pub fn has_conflicts(&self) -> bool {
        !self.skipped_details.is_empty() || !self.pending_details.is_empty()
    }

    /// Count skipped items by reason.
    #[must_use]
    pub fn skipped_count_by_reason(&self, reason: RestoreSkipReason) -> usize {
        self.skipped_details
            .iter()
            .filter(|item| item.reason == reason)
            .count()
    }

    /// Count pending items by reason.
    #[must_use]
    pub fn pending_count_by_reason(&self, reason: RestorePendingReason) -> usize {
        self.pending_details
            .iter()
            .filter(|item| item.reason == reason)
            .count()
    }

    /// Return skipped item ids for a specific reason.
    #[must_use]
    pub fn skipped_ids_by_reason(&self, reason: RestoreSkipReason) -> Vec<&str> {
        self.skipped_details
            .iter()
            .filter(|item| item.reason == reason)
            .map(|item| item.id.as_str())
            .collect()
    }

    /// Return pending item ids for a specific reason.
    #[must_use]
    pub fn pending_ids_by_reason(&self, reason: RestorePendingReason) -> Vec<&str> {
        self.pending_details
            .iter()
            .filter(|item| item.reason == reason)
            .map(|item| item.id.as_str())
            .collect()
    }

    /// Get total item count
    #[must_use]
    pub fn total(&self) -> usize {
        self.restored.len() + self.skipped.len()
    }

    /// Would this restore have made changes (for dry run results)
    #[must_use]
    pub fn would_change(&self) -> bool {
        !self.restored.is_empty() || self.checksum_valid == Some(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_result_reports_conflicts_and_reason_counts() {
        let mut result = RestoreResult::default();
        assert!(!result.has_conflicts());

        result.add_skipped("settings.json", RestoreSkipReason::ExistsConflict);
        result.add_skipped("external_ro", RestoreSkipReason::ReadOnlyImportTarget);
        result.add_pending(
            "external_missing",
            RestorePendingReason::UnknownExternalConfig,
        );

        assert!(result.has_conflicts());
        assert_eq!(
            result.skipped_count_by_reason(RestoreSkipReason::ExistsConflict),
            1
        );
        assert_eq!(
            result.skipped_count_by_reason(RestoreSkipReason::ReadOnlyImportTarget),
            1
        );
        assert_eq!(
            result.pending_count_by_reason(RestorePendingReason::UnknownExternalConfig),
            1
        );
        assert_eq!(
            result.pending_count_by_reason(RestorePendingReason::MissingSourceProfile),
            0
        );
    }

    #[test]
    fn restore_result_returns_ids_by_reason() {
        let mut result = RestoreResult::default();

        result.add_skipped("a", RestoreSkipReason::ExistsConflict);
        result.add_skipped("b", RestoreSkipReason::ReadOnlyImportTarget);
        result.add_skipped("c", RestoreSkipReason::ExistsConflict);

        result.add_pending("p1", RestorePendingReason::UnknownExternalConfig);
        result.add_pending("p2", RestorePendingReason::ProfileSelectionRequired);

        assert_eq!(
            result.skipped_ids_by_reason(RestoreSkipReason::ExistsConflict),
            vec!["a", "c"]
        );
        assert_eq!(
            result.pending_ids_by_reason(RestorePendingReason::ProfileSelectionRequired),
            vec!["p2"]
        );
    }
}
