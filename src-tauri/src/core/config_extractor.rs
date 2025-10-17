use serde_json::Value;
use std::collections::HashMap;

/// Converts a JSON object to a HashMap for rclone operations
fn json_to_hashmap(json: Option<&Value>) -> Option<HashMap<String, Value>> {
    json.and_then(|v| v.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// Extracts a string value from nested JSON path
fn get_string(json: &Value, path: &[&str]) -> String {
    let mut current = json;
    for key in path {
        current = &current[key];
    }
    current.as_str().unwrap_or("").to_string()
}

/// Extracts a bool value from nested JSON path
fn get_bool(json: &Value, path: &[&str], default: bool) -> bool {
    let mut current = json;
    for key in path {
        current = &current[key];
    }
    current.as_bool().unwrap_or(default)
}

/// Extracts a u64 value from nested JSON path
fn get_u64(json: &Value, path: &[&str], default: u64) -> u64 {
    let mut current = json;
    for key in path {
        current = &current[key];
    }
    current.as_u64().unwrap_or(default)
}

/// Trait for validating configurations via a common method name.
pub trait IsValid {
    fn is_valid(&self) -> bool;
}

/// Configuration extractor for mount operations
#[derive(Clone)]
pub struct MountConfig {
    pub source: String,
    pub dest: String,
    pub mount_type: String,
    pub mount_options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
}

impl MountConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let mount_cfg = &settings["mountConfig"];

        Self {
            source: get_string(mount_cfg, &["source"]),
            dest: get_string(mount_cfg, &["dest"]),
            mount_type: mount_cfg
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("mount")
                .to_string(),
            mount_options: json_to_hashmap(mount_cfg.get("options")),
            vfs_options: json_to_hashmap(settings.get("vfsConfig")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        }
    }

    pub fn is_valid(&self) -> bool {
        !self.source.is_empty() && !self.dest.is_empty()
    }
}

impl IsValid for MountConfig {
    fn is_valid(&self) -> bool {
        // Call the inherent method
        MountConfig::is_valid(self)
    }
}

/// Configuration extractor for sync operations
#[derive(Clone)]
pub struct SyncConfig {
    pub source: String,
    pub dest: String,
    pub create_empty_src_dirs: bool,
    pub sync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
}

impl SyncConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let sync_cfg = &settings["syncConfig"];

        Self {
            source: get_string(sync_cfg, &["source"]),
            dest: get_string(sync_cfg, &["dest"]),
            create_empty_src_dirs: get_bool(sync_cfg, &["createEmptySrcDirs"], false),
            sync_options: json_to_hashmap(sync_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        }
    }

    pub fn is_valid(&self) -> bool {
        !self.source.is_empty() && !self.dest.is_empty()
    }
}

impl IsValid for SyncConfig {
    fn is_valid(&self) -> bool {
        SyncConfig::is_valid(self)
    }
}

/// Configuration extractor for copy operations
#[derive(Clone)]
pub struct CopyConfig {
    pub source: String,
    pub dest: String,
    pub create_empty_src_dirs: bool,
    pub copy_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
}

impl CopyConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let copy_cfg = &settings["copyConfig"];

        Self {
            source: get_string(copy_cfg, &["source"]),
            dest: get_string(copy_cfg, &["dest"]),
            create_empty_src_dirs: get_bool(copy_cfg, &["createEmptySrcDirs"], false),
            copy_options: json_to_hashmap(copy_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        }
    }

    pub fn is_valid(&self) -> bool {
        !self.dest.is_empty()
    }
}

impl IsValid for CopyConfig {
    fn is_valid(&self) -> bool {
        CopyConfig::is_valid(self)
    }
}

/// Configuration extractor for move operations
#[derive(Clone)]
pub struct MoveConfig {
    pub source: String,
    pub dest: String,
    pub create_empty_src_dirs: bool,
    pub delete_empty_src_dirs: bool,
    pub move_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
}

impl MoveConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let move_cfg = &settings["moveConfig"];

        Self {
            source: get_string(move_cfg, &["source"]),
            dest: get_string(move_cfg, &["dest"]),
            create_empty_src_dirs: get_bool(move_cfg, &["createEmptySrcDirs"], false),
            delete_empty_src_dirs: get_bool(move_cfg, &["deleteEmptySrcDirs"], false),
            move_options: json_to_hashmap(move_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        }
    }

    pub fn is_valid(&self) -> bool {
        !self.source.is_empty() && !self.dest.is_empty()
    }
}

impl IsValid for MoveConfig {
    fn is_valid(&self) -> bool {
        MoveConfig::is_valid(self)
    }
}

/// Configuration extractor for bisync operations
#[derive(Clone)]
pub struct BisyncConfig {
    pub source: String,
    pub dest: String,
    pub dry_run: bool,
    pub resync: bool,
    pub check_access: bool,
    pub check_filename: Option<String>,
    pub max_delete: i64,
    pub force: bool,
    pub check_sync: Option<String>,
    pub create_empty_src_dirs: bool,
    pub remove_empty_dirs: bool,
    pub filters_file: Option<String>,
    pub ignore_listing_checksum: bool,
    pub resilient: bool,
    pub workdir: Option<String>,
    pub backupdir1: Option<String>,
    pub backupdir2: Option<String>,
    pub no_cleanup: bool,
    pub bisync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
}

impl BisyncConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let bisync_cfg = &settings["bisyncConfig"];

        Self {
            source: get_string(bisync_cfg, &["source"]),
            dest: get_string(bisync_cfg, &["dest"]),
            dry_run: get_bool(bisync_cfg, &["dryRun"], false),
            resync: get_bool(bisync_cfg, &["resync"], false),
            check_access: get_bool(bisync_cfg, &["checkAccess"], false),
            check_filename: bisync_cfg
                .get("checkFilename")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            max_delete: get_u64(bisync_cfg, &["maxDelete"], 0) as i64,
            force: get_bool(bisync_cfg, &["force"], false),
            check_sync: bisync_cfg.get("checkSync").and_then(|v| {
                if let Some(b) = v.as_bool() {
                    Some(if b {
                        "true".to_string()
                    } else {
                        "false".to_string()
                    })
                } else {
                    v.as_str().map(|s| s.to_string())
                }
            }),
            create_empty_src_dirs: get_bool(bisync_cfg, &["createEmptySrcDirs"], false),
            remove_empty_dirs: get_bool(bisync_cfg, &["removeEmptyDirs"], false),
            filters_file: bisync_cfg
                .get("filtersFile")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            ignore_listing_checksum: get_bool(bisync_cfg, &["ignoreListingChecksum"], false),
            resilient: get_bool(bisync_cfg, &["resilient"], false),
            workdir: bisync_cfg
                .get("workdir")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            backupdir1: bisync_cfg
                .get("backupdir1")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            backupdir2: bisync_cfg
                .get("backupdir2")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            no_cleanup: get_bool(bisync_cfg, &["noCleanup"], false),
            bisync_options: json_to_hashmap(bisync_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        }
    }

    pub fn is_valid(&self) -> bool {
        !self.source.is_empty() && !self.dest.is_empty()
    }
}

impl IsValid for BisyncConfig {
    fn is_valid(&self) -> bool {
        BisyncConfig::is_valid(self)
    }
}
