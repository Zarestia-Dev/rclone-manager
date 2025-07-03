pub mod cache;
pub mod engine;
pub mod job;
pub mod log;
pub mod watcher;

// Re-export commonly used items for backwards compatibility
pub use cache::{CACHE, get_cached_remotes, get_configs, get_settings, get_cached_mounted_remotes};
pub use engine::ENGINE_STATE;
pub use job::{JOB_CACHE, get_jobs, delete_job, get_job_status, get_active_jobs};
pub use log::{LOG_CACHE, get_remote_logs, clear_remote_logs};
pub use watcher::{start_mounted_remote_watcher, stop_mounted_remote_watcher, force_check_mounted_remotes};