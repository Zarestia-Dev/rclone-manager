//! librclone FFI bindings.
//!
//! This module is only compiled under `#[cfg(feature = "librclone")]`.
//! It provides Rust bindings to the four C symbols that librclone exports
//! (built from `rclone/librclone/`):
//!
//! - `RcloneInitialize()` — initialize rclone logging, config storage and accounting.
//! - `RcloneFinalize()` — request Go garbage collection (does not stop jobs).
//! - `RcloneRpc(input: *const c_char, output: *mut *mut c_char) -> c_int` —
//!   execute an rc call. `input` is JSON with `_path` set to the endpoint.
//!   Returns HTTP-equivalent status (200 = success). Caller frees `output`
//!   with `RcloneFreeString`.
//! - `RcloneFreeString(s: *mut c_char)` — free a string from `RcloneRpc`.
//!
//! # Thread safety
//!
//! Ordinary RPC calls may run concurrently. A library lock excludes synchronous
//! RPCs during initialization, finalization and config/cache path changes.
//! It does not synchronize background Go jobs or direct VFS handle operations.
//! Async callers use `crate::utils::spawn_blocking` because the C-to-Go boundary
//! blocks the calling OS thread.
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
//! `backend/core/librclone/<target-triple>/librclone.a`. The `build.rs` script
//! links it. See `scripts/build-librclone.sh` for how to produce the archive.

use parking_lot::RwLock;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

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

#[derive(Default)]
struct LibraryState {
    initialized: bool,
    paths_configured: bool,
}

static LIBRARY: RwLock<LibraryState> = RwLock::new(LibraryState {
    initialized: false,
    paths_configured: false,
});

impl LibraryState {
    // The write lock publishes readiness only after all initialization finishes.
    #[allow(clippy::disallowed_methods)]
    fn initialize(&mut self) {
        if self.initialized {
            return;
        }
        log::info!("Initializing librclone (RcloneInitialize)");
        unsafe {
            std::env::set_var("RCLONE_ASK_PASSWORD", "false");
        }
        sync_env("RCLONE_ASK_PASSWORD");
        unsafe { RcloneInitialize() };
        self.initialized = true;
    }
}

/// Initialize the library and set default paths once, shared by Tauri and SAF.
/// Explicit config/setpath calls must survive later transport/SAF lookups.
pub fn configure_default_paths(
    config: &std::path::Path,
    cache: &std::path::Path,
) -> Result<(), BackendError> {
    {
        let state = LIBRARY.read();
        if state.initialized && state.paths_configured {
            return Ok(());
        }
    }
    let mut state = LIBRARY.write();
    state.initialize();
    if state.paths_configured {
        return Ok(());
    }
    rpc_initialized(&serde_json::json!({"_path": "config/setpath", "path": config}))?;
    rpc_initialized(&serde_json::json!({"_path": "config/setcachedir", "path": cache}))?;
    state.paths_configured = true;
    log::info!(
        "Configured librclone paths: config={}, cache={}",
        config.display(),
        cache.display()
    );
    Ok(())
}

/// Request Go garbage collection after application-owned jobs/services stop.
/// Upstream Finalize does not cancel async jobs or destroy the Go runtime.
pub fn finalize() {
    let mut state = LIBRARY.write();
    if state.initialized {
        log::info!("Finalizing librclone (RcloneFinalize)");
        unsafe { RcloneFinalize() };
        state.initialized = false;
    }
}

/// Refresh library initialization without allowing RPCs through the transition.
/// Config paths survive; this does not promise cancellation of existing jobs/VFS.
pub fn restart() {
    let mut state = LIBRARY.write();
    if state.initialized {
        unsafe { RcloneFinalize() };
        state.initialized = false;
    }
    state.initialize();
}

fn with_library<T>(
    method: &str,
    call: impl FnOnce() -> Result<T, BackendError>,
) -> Result<T, BackendError> {
    let check = |state: &LibraryState| {
        if state.initialized && state.paths_configured {
            Ok(())
        } else {
            Err(BackendError::NotConnected(
                "librclone startup is incomplete".into(),
            ))
        }
    };
    if matches!(method, "config/setpath" | "config/setcachedir") {
        let state = LIBRARY.write();
        check(&state)?;
        call()
    } else {
        // Cancellation must reach an active RPC even when a lifecycle writer is
        // waiting for it. Recursive reads admit these control calls alongside
        // existing readers, while still excluding an acquired write lock.
        let state = if matches!(
            method,
            "operations/cancelread" | "job/stop" | "job/stopgroup"
        ) {
            LIBRARY.read_recursive()
        } else {
            LIBRARY.read()
        };
        check(&state)?;
        call()
    }
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
    let method = input
        .get("_path")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    with_library(method, || rpc_initialized(input))
}

fn rpc_initialized(input: &Value) -> Result<Value, BackendError> {
    sync_env("RCLONE_CONFIG_PASS");

    // Extract endpoint name from the "_path" field
    let endpoint = input
        .get("_path")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let c_method = CString::new(endpoint)
        .map_err(|e| BackendError::Other(format!("CString conversion failed for method: {e}")))?;

    // Prepare the input JSON string (omitting _path without deep cloning unchanged inputs)
    let input_str = if let Value::Object(map) = input {
        if map.contains_key("_path") {
            let filtered: serde_json::Map<_, _> = map
                .iter()
                .filter(|(k, _)| k.as_str() != "_path")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            serde_json::to_string(&filtered)?
        } else {
            serde_json::to_string(input)?
        }
    } else {
        serde_json::to_string(input)?
    };

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
            endpoint: endpoint.to_string(),
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
            endpoint: endpoint.to_string(),
            status: status as u16,
            message,
        });
    }

    Ok(parsed)
}

/// Execute a raw rc call via librclone FFI returning the JSON string directly without intermediate serde_json parsing.
#[cfg(target_os = "android")]
pub fn rpc_raw(method: &str, input_json: &str) -> Result<String, BackendError> {
    with_library(method, || rpc_raw_initialized(method, input_json))
}

#[cfg(target_os = "android")]
fn rpc_raw_initialized(method: &str, input_json: &str) -> Result<String, BackendError> {
    sync_env("RCLONE_CONFIG_PASS");

    let c_method = CString::new(method)
        .map_err(|e| BackendError::Other(format!("CString conversion failed for method: {e}")))?;
    let c_input = CString::new(input_json)
        .map_err(|e| BackendError::Other(format!("CString conversion failed for input: {e}")))?;

    let result = unsafe { RcloneRpc(c_method.as_ptr(), c_input.as_ptr()) };
    let output_ptr = result.output;

    if output_ptr.is_null() {
        return Err(BackendError::Rpc {
            endpoint: method.to_string(),
            status: result.status as u16,
            message: "null output from librclone (RcloneRpc returned null output pointer)".into(),
        });
    }

    let output_cstr = unsafe { CStr::from_ptr(output_ptr) };
    let output_str = output_cstr.to_str().map_err(|e| {
        unsafe { RcloneFreeString(output_ptr) };
        BackendError::Other(format!("librclone output not valid UTF-8: {e}"))
    })?;

    let res = output_str.to_string();
    unsafe { RcloneFreeString(output_ptr) };

    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Barrier, mpsc},
        time::Duration,
    };

    #[test]
    fn native_library_fixture() {
        let Ok(mode) = std::env::var("RCMAN_FFI_TEST_MODE") else {
            return;
        };
        assert!(matches!(
            rpc(&serde_json::json!({"_path":"core/version"})),
            Err(BackendError::NotConnected(_))
        ));
        assert!(matches!(
            rpc(&serde_json::json!({"_path":"operations/cancelread", "readToken":"early"})),
            Err(BackendError::NotConnected(_))
        ));
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("rclone.conf");
        let selected = directory.path().join("selected.conf");
        let cache = directory.path().join("cache");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(&original, b"[original]\ntype = local\n").unwrap();
        std::fs::write(&selected, b"[selected]\ntype = local\n").unwrap();
        configure_default_paths(&original, &cache).unwrap();

        if mode == "paths" {
            rpc(&serde_json::json!({"_path":"config/setpath", "path": selected})).unwrap();
            for _ in 0..5 {
                configure_default_paths(&original, &cache).unwrap();
                assert_eq!(
                    rpc(&serde_json::json!({"_path":"config/paths"})).unwrap()["config"],
                    selected.to_string_lossy().as_ref()
                );
            }
            restart();
            assert_eq!(
                rpc(&serde_json::json!({"_path":"config/paths"})).unwrap()["config"],
                selected.to_string_lossy().as_ref()
            );
            let remotes = rpc(&serde_json::json!({"_path":"config/listremotes"})).unwrap();
            assert_eq!(remotes["remotes"], serde_json::json!(["selected"]));
            finalize();
            assert!(matches!(
                rpc(&serde_json::json!({"_path":"core/version"})),
                Err(BackendError::NotConnected(_))
            ));
            configure_default_paths(&original, &cache).unwrap();
            assert_eq!(
                rpc(&serde_json::json!({"_path":"config/paths"})).unwrap()["config"],
                selected.to_string_lossy().as_ref()
            );
        } else if mode == "cancellation" {
            for method in ["operations/cancelread", "job/stop", "job/stopgroup"] {
                let (entered, reading) = mpsc::channel();
                let (release, released) = mpsc::channel();
                let reader = std::thread::spawn(move || {
                    with_library("operations/readfile", || {
                        entered.send(()).unwrap();
                        released.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(())
                    })
                    .unwrap();
                });
                reading.recv_timeout(Duration::from_secs(2)).unwrap();
                let writer = std::thread::spawn(|| {
                    with_library("config/setpath", || Ok(())).unwrap();
                });
                // A queued writer blocks ordinary new readers. Keep the active
                // read alive until cancellation can get through that queue.
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while LIBRARY.try_read().is_some() {
                    assert!(std::time::Instant::now() < deadline, "Writer did not queue");
                    std::thread::yield_now();
                }
                let (cancelled, cancellation) = mpsc::channel();
                let cancel_release = release.clone();
                let cancel = std::thread::spawn(move || {
                    with_library(method, || {
                        cancelled.send(()).unwrap();
                        cancel_release.send(()).unwrap();
                        Ok(())
                    })
                    .unwrap();
                });
                let result = cancellation.recv_timeout(Duration::from_secs(2));
                // Unblock the threads even if the assertion would fail.
                if result.is_err() {
                    let _ = release.send(());
                }
                reader.join().unwrap();
                writer.join().unwrap();
                cancel.join().unwrap();
                assert!(result.is_ok(), "{method} was blocked by the queued writer");
            }
        } else {
            // Concurrent read RPCs are allowed; a lifecycle change waits for both.
            let release = Arc::new(Barrier::new(3));
            let (entered, waiting) = mpsc::channel();
            let readers: Vec<_> = (0..2)
                .map(|_| {
                    let release = release.clone();
                    let entered = entered.clone();
                    std::thread::spawn(move || {
                        with_library("core/version", || {
                            entered.send(()).unwrap();
                            release.wait();
                            Ok(())
                        })
                        .unwrap()
                    })
                })
                .collect();
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(LIBRARY.try_write().is_none());
            let (done, finished) = mpsc::channel();
            let restarting = std::thread::spawn(move || {
                restart();
                done.send(()).unwrap();
            });
            assert!(finished.recv_timeout(Duration::from_millis(100)).is_err());
            release.wait();
            for reader in readers {
                reader.join().unwrap();
            }
            finished.recv_timeout(Duration::from_secs(5)).unwrap();
            restarting.join().unwrap();
            rpc(&serde_json::json!({"_path":"core/version"})).unwrap();

            with_library("config/setpath", || {
                assert!(LIBRARY.try_read().is_none());
                assert!(LIBRARY.try_read_recursive().is_none());
                Ok(())
            })
            .unwrap();
        }
        finalize();
    }

    fn run_fixture(mode: &str) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "rclone::backend::rclone_ffi::tests::native_library_fixture",
                "--nocapture",
            ])
            .env("RCMAN_FFI_TEST_MODE", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn repeated_defaults_and_restart_preserve_the_selected_config() {
        run_fixture("paths");
    }

    #[test]
    fn lifecycle_changes_wait_for_calls_without_serializing_readers() {
        run_fixture("concurrency");
    }

    #[test]
    fn cancellation_reaches_active_calls_while_a_config_writer_waits() {
        run_fixture("cancellation");
    }
}
