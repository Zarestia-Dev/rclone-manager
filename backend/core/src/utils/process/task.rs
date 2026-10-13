use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::{Handle, Runtime};
use tokio::task::JoinHandle;

static RUNTIME_HANDLE: OnceLock<Handle> = OnceLock::new();

fn build_runtime() -> Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("rcman-worker")
        .build()
        .expect("Failed to initialize Tokio runtime")
}

/// Creates and registers the process runtime. Call once from the executable's
/// entry point, then keep the runtime and its `enter()` guard alive until exit.
pub fn init_runtime() -> Runtime {
    let runtime = build_runtime();
    init_runtime_handle(runtime.handle().clone());
    runtime
}

/// Registers the global Tokio runtime handle for the application.
pub fn init_runtime_handle(handle: Handle) {
    let _ = RUNTIME_HANDLE.set(handle);
}

/// Returns the global Tokio runtime handle.
///
/// Falls back to `Handle::try_current()` (e.g. inside tests) or lazily initializes
/// a multi-threaded Tokio runtime if one has not been explicitly provided.
pub fn runtime_handle() -> Handle {
    if let Some(h) = RUNTIME_HANDLE.get() {
        h.clone()
    } else if let Ok(current) = Handle::try_current() {
        current
    } else {
        static FALLBACK_RUNTIME: OnceLock<Runtime> = OnceLock::new();
        FALLBACK_RUNTIME.get_or_init(build_runtime).handle().clone()
    }
}

/// Spawns an asynchronous background task onto the Tokio runtime.
///
/// Uses `Handle::spawn()` to dispatch directly onto the runtime without
/// requiring the current thread to have entered a Tokio context, preventing
/// "there is no reactor running" panics from non-Tokio threads such as
/// the main GUI thread, setup hooks, or OS event callbacks.
#[track_caller]
pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    runtime_handle().spawn(future)
}

/// Spawns a blocking task onto an executor dedicated to blocking operations.
#[track_caller]
pub fn spawn_blocking<F, R>(func: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    runtime_handle().spawn_blocking(func)
}

/// Runs a future to completion on the Tokio runtime, blocking the current thread.
///
/// Can be called safely from synchronous OS threads or hooks where an async task
/// needs to complete before proceeding.
#[track_caller]
pub fn block_on<F: Future>(future: F) -> F::Output {
    let handle = runtime_handle();
    handle.block_on(future)
}

#[cfg(test)]
mod tests {
    use super::build_runtime;

    #[test]
    fn runtime_supports_timers_and_named_workers() {
        // Build locally so this test does not replace the process-wide handle.
        let runtime = build_runtime();
        let worker = runtime.spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            std::thread::current().name().map(str::to_owned)
        });
        assert_eq!(
            runtime.block_on(worker).unwrap().as_deref(),
            Some("rcman-worker")
        );
    }
}
