pub mod cache;
pub mod engine;
pub mod job;
pub mod log;
pub mod scheduled_tasks;
pub mod watcher;

// Re-export commonly used items for backwards compatibility
pub use cache::{CACHE, get_cached_mounted_remotes, get_cached_remotes, get_configs, get_settings};
pub use engine::ENGINE_STATE;
pub use job::{JOB_CACHE, delete_job, get_active_jobs, get_job_status, get_jobs};
pub use log::{LOG_CACHE, clear_remote_logs, get_remote_logs};
pub use scheduled_tasks::{
    get_scheduled_task, get_scheduled_tasks, get_scheduled_tasks_stats,
    reload_scheduled_tasks_from_configs,
};
pub use watcher::{
    force_check_mounted_remotes, start_mounted_remote_watcher, stop_mounted_remote_watcher,
};
