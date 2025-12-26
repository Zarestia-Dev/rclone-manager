use log::debug;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, State};

use crate::{
    rclone::backend::BACKEND_MANAGER,
    utils::{
        json_helpers::{
            get_string, json_to_hashmap, resolve_profile_options, unwrap_nested_options,
        },
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, sync},
        types::all_types::{LogLevel, ProfileParams, RcloneState},
    },
};

use super::job::{JobMetadata, submit_job};

// ============================================================================
// SHARED TYPES
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TransferType {
    Sync,
    Copy,
    Move,
    Bisync,
}

impl TransferType {
    pub fn as_str(&self) -> &'static str {
        match self {
            TransferType::Sync => "sync",
            TransferType::Copy => "copy",
            TransferType::Move => "move",
            TransferType::Bisync => "bisync",
        }
    }

    pub fn operation_name(&self) -> &'static str {
        match self {
            TransferType::Sync => "Sync operation",
            TransferType::Copy => "Copy operation",
            TransferType::Move => "Move operation",
            TransferType::Bisync => "Bisync operation",
        }
    }

    pub fn endpoint(&self) -> &'static str {
        match self {
            TransferType::Sync => sync::SYNC,
            TransferType::Copy => sync::COPY,
            TransferType::Move => sync::MOVE,
            TransferType::Bisync => sync::BISYNC,
        }
    }
}

/// Unified parameter structure for all transfer operations
#[derive(Debug, Clone)]
pub struct GenericTransferParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
    pub transfer_type: TransferType,
}

// ============================================================================
// SPECIFIC PARAMS (KEPT FOR FRONTEND COMPATIBILITY)
// ============================================================================

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct SyncParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub sync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct CopyParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub copy_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct MoveParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub move_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct BisyncParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub bisync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

// ============================================================================
// CONVERSIONS
// ============================================================================

impl From<SyncParams> for GenericTransferParams {
    fn from(p: SyncParams) -> Self {
        Self {
            remote_name: p.remote_name,
            source: p.source,
            dest: p.dest,
            options: p.sync_options,
            filter_options: p.filter_options,
            backend_options: p.backend_options,
            profile: p.profile,
            transfer_type: TransferType::Sync,
        }
    }
}

impl From<CopyParams> for GenericTransferParams {
    fn from(p: CopyParams) -> Self {
        Self {
            remote_name: p.remote_name,
            source: p.source,
            dest: p.dest,
            options: p.copy_options,
            filter_options: p.filter_options,
            backend_options: p.backend_options,
            profile: p.profile,
            transfer_type: TransferType::Copy,
        }
    }
}

impl From<MoveParams> for GenericTransferParams {
    fn from(p: MoveParams) -> Self {
        Self {
            remote_name: p.remote_name,
            source: p.source,
            dest: p.dest,
            options: p.move_options,
            filter_options: p.filter_options,
            backend_options: p.backend_options,
            profile: p.profile,
            transfer_type: TransferType::Move,
        }
    }
}

impl From<BisyncParams> for GenericTransferParams {
    fn from(p: BisyncParams) -> Self {
        Self {
            remote_name: p.remote_name,
            source: p.source,
            dest: p.dest,
            options: p.bisync_options,
            filter_options: p.filter_options,
            backend_options: p.backend_options,
            profile: p.profile,
            transfer_type: TransferType::Bisync,
        }
    }
}

// ============================================================================
// CONFIG PARSING HELPER
// ============================================================================

trait FromConfig: Sized {
    /// Create Params from a profile config and settings
    fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self>;
}

// Macro to avoid repeating from_config logic
macro_rules! impl_from_config {
    ($type:ty, $opt_field:ident) => {
        impl FromConfig for $type {
            fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
                let source = get_string(config, &["source"]);
                let dest = get_string(config, &["dest"]);

                if source.is_empty() || dest.is_empty() {
                    return None;
                }

                let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
                let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());

                let filter_options =
                    resolve_profile_options(settings, filter_profile, "filterConfigs");
                let backend_options =
                    resolve_profile_options(settings, backend_profile, "backendConfigs");

                Some(Self {
                    remote_name,
                    source,
                    dest,
                    $opt_field: json_to_hashmap(config.get("options")),
                    filter_options,
                    backend_options,
                    profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
                })
            }
        }
    };
}

impl_from_config!(SyncParams, sync_options);
impl_from_config!(CopyParams, copy_options);
impl_from_config!(MoveParams, move_options);
impl_from_config!(BisyncParams, bisync_options);

// ============================================================================
// CORE LOGIC
// ============================================================================

/// Helper for merging options
fn merge_options(
    main_opts: Option<HashMap<String, Value>>,
    backend_opts: Option<HashMap<String, Value>>,
) -> HashMap<String, Value> {
    let main = main_opts.map(unwrap_nested_options);
    let backend = backend_opts.map(unwrap_nested_options);

    match (main, backend) {
        (Some(mut opts), Some(backend_unwrapped)) => {
            opts.extend(backend_unwrapped);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend_unwrapped)) => backend_unwrapped,
        (None, None) => HashMap::new(),
    }
}

/// Generic function to perform any transfer operation
async fn perform_transfer(
    app: AppHandle,
    rclone_state: State<'_, RcloneState>,
    params: GenericTransferParams,
) -> Result<u64, String> {
    debug!(
        "Starting {} with params: {:#?}",
        params.transfer_type.as_str(),
        params
    );

    let op_name = params.transfer_type.operation_name();

    // 1. Log Operation Start
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some(op_name.to_string()),
        format!(
            "Starting {} from {} to {}",
            params.transfer_type.as_str(),
            params.source,
            params.dest
        ),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
            "options": params.options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );

    // 2. Build Request Body
    let mut body = Map::new();

    // Bisync uses path1/path2, others use srcFs/dstFs
    if params.transfer_type == TransferType::Bisync {
        body.insert("path1".to_string(), Value::String(params.source.clone()));
        body.insert("path2".to_string(), Value::String(params.dest.clone()));
    } else {
        body.insert("srcFs".to_string(), Value::String(params.source.clone()));
        body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    }
    body.insert("_async".to_string(), Value::Bool(true));

    let mut opts = params.options.unwrap_or_default();

    // 3. Handle Special Top-Level Parameters
    // Some parameters must be pulled out of 'options' and placed at the top level of the JSON body.
    // We define a superset of such keys for all operations.
    // It's safe to check/remove them even if not relevant for a specific op (they just won't exist).
    let top_level_keys = [
        "createEmptySrcDirs", // sync, copy, move, bisync
        "deleteEmptySrcDirs", // move
        // bisync specific:
        "resync",
        "checkAccess",
        "checkFilename",
        "maxDelete",
        "force",
        "checkSync",
        "removeEmptyDirs",
        "filtersFile",
        "ignoreListingChecksum",
        "resilient",
        "workDir",
        "backupDir1",
        "backupDir2",
        "noCleanup",
        "dryRun",
    ];

    for key in top_level_keys {
        if let Some(val) = opts.remove(key) {
            // Only add boolean true flags if they are booleans, or pass value through if not
            match val {
                Value::Bool(b) => {
                    if b {
                        body.insert(key.to_string(), Value::Bool(true));
                    }
                }
                _ => {
                    body.insert(key.to_string(), val);
                }
            }
        }
    }

    // 4. Merge Remaining Options into _config
    let config_map = merge_options(Some(opts), params.backend_options);
    if !config_map.is_empty() {
        body.insert(
            "_config".to_string(),
            Value::Object(config_map.into_iter().collect()),
        );
    }

    // 5. Add Filters
    if let Some(filters) = params.filter_options {
        let unwrapped_filters = unwrap_nested_options(filters);
        body.insert(
            "_filter".to_string(),
            Value::Object(unwrapped_filters.into_iter().collect()),
        );
    }

    // 6. Get API URL
    let backend_manager = &BACKEND_MANAGER;
    let backend = backend_manager
        .get_active()
        .await
        .ok_or_else(|| "No active backend".to_string())?;

    let backend_guard = backend.read().await;
    let url = EndpointHelper::build_url(&backend_guard.api_url(), params.transfer_type.endpoint());

    // 7. Submit Job
    let (jobid, _) = submit_job(
        app,
        rclone_state.client.clone(),
        backend_guard.inject_auth(rclone_state.client.clone().post(&url)),
        Value::Object(body),
        JobMetadata {
            remote_name: params.remote_name,
            job_type: params.transfer_type.as_str().to_string(),
            operation_name: op_name.to_string(),
            source: params.source,
            destination: params.dest,
            profile: params.profile,
            source_ui: None,
        },
    )
    .await?;

    Ok(jobid)
}

// ============================================================================
// PROFILE COMMANDS
// ============================================================================

/// Helper to load profile logic generic over T which implements FromConfig.
/// Using a macro for the profile commands because they need async/await and
/// generic bounds that are slightly verbose to write as a single generic function
/// referencing T::from_config which is not async but needs async context for settings.
/// Actually, duplicates are clearer here than a complex generic async function.
/// But we can simplify the body significantly.
async fn load_profile_and_run<T>(
    app: AppHandle,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
    config_key: &str,
) -> Result<u64, String>
where
    T: FromConfig + Into<GenericTransferParams>,
{
    let (config, settings) = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        config_key,
    )
    .await?;

    let specific_params = T::from_config(params.remote_name.clone(), &config, &settings)
        .ok_or_else(|| {
            format!(
                "Configuration incomplete for profile '{}'",
                params.profile_name
            )
        })?;

    // specific_params.profile is set in from_config, but we ensure consistency here if needed
    // The From implementation handles conversion to GenericTransferParams
    perform_transfer(app, rclone_state, specific_params.into()).await
}

#[tauri::command]
pub async fn start_sync_profile(
    app: AppHandle,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    load_profile_and_run::<SyncParams>(app, rclone_state, params, "syncConfigs").await
}

#[tauri::command]
pub async fn start_copy_profile(
    app: AppHandle,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    load_profile_and_run::<CopyParams>(app, rclone_state, params, "copyConfigs").await
}

#[tauri::command]
pub async fn start_move_profile(
    app: AppHandle,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    load_profile_and_run::<MoveParams>(app, rclone_state, params, "moveConfigs").await
}

#[tauri::command]
pub async fn start_bisync_profile(
    app: AppHandle,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    load_profile_and_run::<BisyncParams>(app, rclone_state, params, "bisyncConfigs").await
}
