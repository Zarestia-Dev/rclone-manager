//! librclone FFI bindings.
//!
//! This module is only compiled under `#[cfg(feature = "librclone")]`.
//! It provides Rust bindings to the four C symbols that librclone exports
//! (built from `rclone/librclone/`):
//!
//! - `RcloneInitialize()` — initialize Go runtime + rclone. Idempotent.
//! - `RcloneFinalize()` — graceful shutdown of rclone.
//! - `RcloneRpc(input: *const c_char, output: *mut *mut c_char) -> c_int` —
//!   execute an rc call. `input` is JSON with `_path` set to the endpoint.
//!   Returns HTTP-equivalent status (200 = success). Caller frees `output`
//!   with `RcloneFreeString`.
//! - `RcloneFreeString(s: *mut c_char)` — free a string from `RcloneRpc`.
//!
//! # Thread safety
//!
//! librclone's `RcloneRpc` is safe to call from multiple threads concurrently —
//! the Go runtime handles its own scheduling. However, we wrap every call in
//! `tokio::task::spawn_blocking` because `RcloneRpc` is a synchronous C call
//! that blocks the calling OS thread (it internally runs Go goroutines but the
//! C-to-Go boundary is synchronous).
//!
//! # Memory management
//!
//! `RcloneRpc` allocates the output string with Go's `C.CString`. The caller
//! MUST free it with `RcloneFreeString` (which calls Go's `C.free`). Leaking
//! it is safe in the sense that Go's allocator won't corrupt, but it wastes
//! memory. Our `rpc()` helper always frees the string, even on error paths.
//!
//! # Build requirements
//!
//! This module requires `librclone.a` (static archive) to be present at
//! `src-tauri/librclone/<target-triple>/librclone.a`. The `build.rs` script
//! links it. See `scripts/build-librclone.sh` for how to produce the archive.

#![cfg(feature = "librclone")]

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::sync::OnceLock;

use serde_json::Value;

use crate::rclone::backend::BackendError;

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct RcloneRpcResult {
    pub output: *mut c_char,
    pub status: c_int,
}

unsafe extern "C" {
    fn RcloneInitialize();
    fn RcloneFinalize();
    #[link_name = "RcloneRPC"]
    fn RcloneRpc(method: *const c_char, input: *const c_char) -> RcloneRpcResult;
    fn RcloneFreeString(s: *mut c_char);
    fn RcloneSyncEnv(key: *const c_char);
}

/// Sync a single environment variable from C to Go.
fn sync_env(key: &str) {
    if let Ok(c_key) = CString::new(key) {
        unsafe { RcloneSyncEnv(c_key.as_ptr()) };
    }
}

/// Guard to ensure RcloneInitialize is called exactly once per process.
/// RcloneInitialize is idempotent in librclone, but calling it once avoids
/// redundant Go runtime setup.
static INIT_GUARD: OnceLock<()> = OnceLock::new();

/// Initialize librclone. Idempotent — safe to call multiple times.
///
/// This should be called once at app startup (from `setup_app` when
/// constructing `RcloneLibBackend`). The Go runtime initialized here lives
/// for the lifetime of the process.
#[allow(clippy::disallowed_methods)]
pub fn initialize() {
    INIT_GUARD.get_or_init(|| {
        log::info!("Initializing librclone (RcloneInitialize)");
        unsafe {
            std::env::set_var("RCLONE_ASK_PASSWORD", "false");
        }
        sync_env("RCLONE_ASK_PASSWORD");
        unsafe { RcloneInitialize() };
    });
}

/// Finalize librclone. Releases Go runtime resources.
///
/// Call this once at app shutdown (from `RcApiEngine::shutdown`). After this,
/// no further `rpc()` calls can be made unless `initialize()` is called again.
/// In practice the process is exiting, so this is just for clean shutdown.
pub fn finalize() {
    log::info!("Finalizing librclone (RcloneFinalize)");
    unsafe { RcloneFinalize() };
}

/// Execute an rc call via librclone FFI.
///
/// `input` must be a JSON object. The `_path` key is set to `endpoint` by the
/// caller (the transport). Returns the parsed JSON output on success.
///
/// On non-200 status, returns `BackendError::Rpc` with the status code and
/// error message extracted from the response body's `"error"` field.
///
/// # Blocking
///
/// This is a synchronous C call that blocks the calling OS thread. Callers
/// MUST wrap it in `tokio::task::spawn_blocking` to avoid stalling the tokio
/// runtime. The `RcloneLibBackend::rpc` impl does this automatically.
pub fn rpc(input: &Value) -> Result<Value, BackendError> {
    sync_env("RCLONE_CONFIG_PASS");

    // Extract endpoint name from the "_path" field
    let endpoint = input
        .get("_path")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let c_method = CString::new(endpoint.clone())
        .map_err(|e| BackendError::Other(format!("CString conversion failed for method: {e}")))?;

    // Prepare the input JSON (everything except _path) to avoid sending internal fields to rclone
    let mut payload = input.clone();
    if let Value::Object(ref mut map) = payload {
        map.remove("_path");
    }

    // Serialize input payload to a JSON string.
    let input_str = serde_json::to_string(&payload)?;

    // Convert to a C string. JSON strings don't contain interior NUL bytes
    // (they'd be escaped as \u0000), so this should always succeed.
    let c_input = CString::new(input_str)
        .map_err(|e| BackendError::Other(format!("CString conversion failed: {e}")))?;

    let result = unsafe { RcloneRpc(c_method.as_ptr(), c_input.as_ptr()) };

    let output_ptr = result.output;
    let status = result.status;

    // If output_ptr is null even on success, that's an error.
    if output_ptr.is_null() {
        return Err(BackendError::Rpc {
            endpoint,
            status: status as u16,
            message: "null output from librclone (RcloneRpc returned null output pointer)".into(),
        });
    }

    // Convert the output C string to a Rust string. This does NOT free the
    // memory — we do that explicitly below.
    let output_cstr = unsafe { CStr::from_ptr(output_ptr) };
    let output_str = output_cstr.to_str().map_err(|e| {
        // Free before returning the error.
        unsafe { RcloneFreeString(output_ptr) };
        BackendError::Other(format!("librclone output not valid UTF-8: {e}"))
    })?;

    // Parse the output as JSON.
    let parsed: Result<Value, _> = serde_json::from_str(output_str);

    // Free the Go-allocated string NOW, regardless of parse success.
    // This is critical — leaking it wastes Go-managed memory.
    unsafe { RcloneFreeString(output_ptr) };

    let parsed = parsed?;

    // Non-200 status means rclone returned an error. The parsed JSON should
    // have an "error" field with the message.
    if status != 200 {
        let message = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown rclone error")
            .to_string();
        return Err(BackendError::Rpc {
            endpoint,
            status: status as u16,
            message,
        });
    }

    Ok(parsed)
}
