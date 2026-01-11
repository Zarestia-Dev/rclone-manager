pub mod backup;
pub mod operations;
pub mod rclone_backend;
pub mod remote;
pub mod schema;

use schema::AppSettings;

/// Type alias for the application's settings manager
/// Uses rcman's TypedManager with our AppSettings schema
pub type AppSettingsManager = rcman::SettingsManager<rcman::storage::JsonStorage, AppSettings>;
