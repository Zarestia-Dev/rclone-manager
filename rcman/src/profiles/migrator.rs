//! Profile Migration Logic
//!
//! Handles migration from flat configuration structure to profile-based structure.
//!
//! The migration strategy is:
//! - Check if the target directory/file exists and is NOT already profiled (no .profiles.json)
//! - Create the "profiles/default" directory structure
//! - Move existing files/contents to the default profile location
//! - Create .profiles.json manifest pointing to "default"

use crate::error::{Error, Result};
use crate::profiles::{DEFAULT_PROFILE, PROFILES_DIR};
use crate::storage::StorageBackend;
use log::{debug, info, warn};
use std::path::Path;

/// Type alias for custom migration closure
type MigrationFn = std::sync::Arc<dyn Fn(&Path) -> Result<()> + Send + Sync>;

/// Migration strategy
#[derive(Clone, Default)]
pub enum ProfileMigrator {
    /// Auto-migrate flat structure to profiles/default/
    #[default]
    Auto,
    /// Custom migration logic
    /// Arguments: (`root_dir`) -> Result<()>
    Custom(MigrationFn),
    /// No migration (error if flat structure found but profiles enabled)
    None,
}

impl std::fmt::Debug for ProfileMigrator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auto => write!(f, "Auto"),
            Self::None => write!(f, "None"),
            Self::Custom(_) => write!(f, "Custom(<closure>)"),
        }
    }
}

/// Execute migration if needed
///
/// # Arguments
///
/// * `root_dir` - The root directory to migrate
/// * `target_name` - The name of the target
/// * `single_file_mode` - Whether to migrate in single file mode
/// * `strategy` - The migration strategy to use
///
/// # Errors
///
/// Returns an error if the migration fails.
/// Execute migration if needed
///
/// # Arguments
///
/// * `root_dir` - The root directory of the *profiled* structure (e.g., "config/backends")
/// * `target_name` - The name of the target (e.g., "backends")
/// * `single_file_mode` - Whether to migrate in single file mode
/// * `extension` - The file extension to look for (e.g., "json")
/// * `strategy` - The migration strategy to use
///
/// # Errors
///
/// Returns an error if the migration fails.
pub fn migrate<S: StorageBackend>(
    root_dir: &Path,
    target_name: &str,
    single_file_mode: bool,
    storage: &S,
    strategy: &ProfileMigrator,
) -> Result<()> {
    let ext = storage.extension();
    let manifest_filename = format!(".profiles.{ext}");
    let manifest_path = root_dir.join(&manifest_filename);

    // If manifest exists, we are usually already profiled.
    // However, we check for a specific failure case in single-file mode where
    // the manifest exists but the legacy file was not moved (partial migration).
    if manifest_path.exists() {
        if single_file_mode {
            let legacy_file = root_dir.with_extension(ext);
            if legacy_file.exists() && legacy_file.is_file() {
                warn!(
                    "Detected partial profile migration for '{target_name}'. Legacy file exists alongside manifest. Retrying migration."
                );
            } else {
                debug!("Profiles already initialized for '{target_name}'");
                return Ok(());
            }
        } else {
            debug!("Profiles already initialized for '{target_name}'");
            return Ok(());
        }
    }

    // Determine if there's anything to migrate
    let needs_migration = if single_file_mode {
        // In single file mode, we check for the existence of the sibling file
        // e.g. "config/backends.json" when root_dir is "config/backends"
        let ext = storage.extension();
        let legacy_file = root_dir.with_extension(ext);
        legacy_file.exists() && legacy_file.is_file()
    } else {
        root_dir.exists()
            && root_dir
                .read_dir()
                .map_err(|e| Error::DirectoryRead {
                    path: root_dir.to_path_buf(),
                    source: e,
                })?
                .count()
                > 0
    };

    if !needs_migration {
        return Ok(());
    }

    info!("Migrating '{target_name}' to profile structure...");

    match strategy {
        ProfileMigrator::None => {
            warn!(
                "Profiles enabled for '{target_name}' but flat structure detected and migration is disabled."
            );
            Ok(())
        }
        ProfileMigrator::Custom(func) => func(root_dir),
        ProfileMigrator::Auto => {
            run_auto_migration(root_dir, target_name, single_file_mode, storage)
        }
    }
}

fn run_auto_migration<S: StorageBackend>(
    root_dir: &Path,
    target_name: &str,
    single_file_mode: bool,
    storage: &S,
) -> Result<()> {
    // Create profiles/default directory
    let default_profile_dir = root_dir.join(PROFILES_DIR).join(DEFAULT_PROFILE);
    crate::utils::security::ensure_secure_dir(&default_profile_dir)?;

    // Move files
    if single_file_mode {
        // Single File Migration: Move sibling file into default profile
        let ext = storage.extension();
        let legacy_file = root_dir.with_extension(ext);
        let dest = default_profile_dir.join(format!("{target_name}.{ext}"));

        debug!(
            "Moving single file {} -> {}",
            legacy_file.display(),
            dest.display()
        );
        std::fs::rename(&legacy_file, &dest).map_err(|e| Error::FileWrite {
            path: dest.clone(),
            source: e,
        })?;
    } else {
        // Multi File Migration: Move items from within root_dir
        if root_dir.is_dir() {
            for entry in std::fs::read_dir(root_dir).map_err(|e| Error::DirectoryRead {
                path: root_dir.to_path_buf(),
                source: e,
            })? {
                let entry = entry.map_err(|e| Error::DirectoryRead {
                    path: root_dir.to_path_buf(),
                    source: e,
                })?;
                let path = entry.path();

                // Skip .profiles.json and profiles/ dir
                // Determine manifest filename to skip
                let ext = storage.extension();
                let manifest_filename = format!(".profiles.{ext}");

                if path.ends_with(&manifest_filename) || path.ends_with(PROFILES_DIR) {
                    continue;
                }

                if let Some(name) = path.file_name() {
                    let dest = default_profile_dir.join(name);
                    debug!("Moving {:?} -> {:?}", path.display(), dest.display());
                    std::fs::rename(&path, &dest).map_err(|e| Error::FileWrite {
                        path: dest.clone(),
                        source: e,
                    })?;
                }
            }
        }
    }

    // Create manifest
    let ext = storage.extension();
    let manifest_filename = format!(".profiles.{ext}");
    let manifest = crate::profiles::ProfileManifest::default();
    let manifest_path = root_dir.join(&manifest_filename);

    // Use storage backend to serialize implementation agnostic manifest
    // This requires ProfileManifest to be serializable by the backend.
    // Since ProfileManifest is usually simple struct, it should representable in JSON/YAML/TOML.
    storage.write(&manifest_path, &manifest)?;

    info!("Successfully migrated '{target_name}' to profiles");
    Ok(())
}

/// Rollback profile structure to flat configuration
///
/// Reverts the profile migration by:
/// - Moving all files from the active profile back to the root directory
/// - Removing the profiles/ directory
/// - Deleting the .profiles.json manifest
///
/// # Warnings
///
/// - Only the **active profile** data is preserved
/// - All other profiles are **permanently deleted**
/// - This operation is **irreversible**
///
/// # Arguments
///
/// * `root_dir` - Root directory containing the profiled structure
/// * `target_name` - Name of the target (for logging)
/// * `single_file_mode` - Whether using single file mode
/// * `storage` - Storage backend for manifest operations
///
/// # Errors
///
/// Returns an error if:
/// - No profile manifest exists (not profiled)
/// - Active profile directory doesn't exist
/// - File operations fail
///
/// # Example
///
/// ```ignore
/// use rcman::profiles::rollback_migration;
///
/// // Rollback remotes to flat structure
/// rollback_migration(
///     &config_dir.join("remotes"),
///     "remotes",
///     false, // multi-file mode
///     &storage
/// )?;
/// ```
pub fn rollback_migration<S: StorageBackend>(
    root_dir: &Path,
    target_name: &str,
    single_file_mode: bool,
    storage: &S,
) -> Result<()> {
    let ext = storage.extension();
    let manifest_filename = format!(".profiles.{ext}");
    let manifest_path = root_dir.join(&manifest_filename);

    // Check if profiles are enabled
    if !manifest_path.exists() {
        return Err(Error::Config(format!(
            "Cannot rollback '{target_name}': not using profiles (no manifest found)"
        )));
    }

    // Read manifest to get active profile
    let manifest: crate::profiles::ProfileManifest = storage.read(&manifest_path)?;
    let active_profile = &manifest.active;

    info!(
        "Rolling back '{target_name}' from profiles to flat structure (preserving '{active_profile}' profile)"
    );

    let active_profile_dir = root_dir.join(PROFILES_DIR).join(active_profile);

    if !active_profile_dir.exists() {
        return Err(Error::Config(format!(
            "Active profile directory not found: {}",
            active_profile_dir.display()
        )));
    }

    // Move files from active profile back to root
    if single_file_mode {
        // Single file: Move profiles/active/target_name.ext -> root_dir.ext
        let source = active_profile_dir.join(format!("{target_name}.{ext}"));
        let dest = root_dir.with_extension(ext);

        if source.exists() {
            debug!(
                "Moving single file {} -> {}",
                source.display(),
                dest.display()
            );
            std::fs::rename(&source, &dest).map_err(|e| Error::FileWrite {
                path: dest.clone(),
                source: e,
            })?;
        }
    } else {
        // Multi-file: Move all items from profiles/active/ back to root_dir/
        if active_profile_dir.is_dir() {
            for entry in
                std::fs::read_dir(&active_profile_dir).map_err(|e| Error::DirectoryRead {
                    path: active_profile_dir.clone(),
                    source: e,
                })?
            {
                let entry = entry.map_err(|e| Error::DirectoryRead {
                    path: active_profile_dir.clone(),
                    source: e,
                })?;
                let source = entry.path();

                if let Some(name) = source.file_name() {
                    let dest = root_dir.join(name);
                    debug!("Moving {:?} -> {:?}", source.display(), dest.display());
                    std::fs::rename(&source, &dest).map_err(|e| Error::FileWrite {
                        path: dest.clone(),
                        source: e,
                    })?;
                }
            }
        }
    }

    // Remove profiles directory
    let profiles_dir = root_dir.join(PROFILES_DIR);
    if profiles_dir.exists() {
        std::fs::remove_dir_all(&profiles_dir).map_err(|e| Error::DirectoryRead {
            path: profiles_dir.clone(),
            source: e,
        })?;
    }

    // Remove manifest
    std::fs::remove_file(&manifest_path).map_err(|e| Error::FileDelete {
        path: manifest_path.clone(),
        source: e,
    })?;

    info!(
        "Successfully rolled back '{target_name}' to flat structure (preserved '{active_profile}' profile data, other profiles deleted)"
    );

    Ok(())
}
