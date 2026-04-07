pub mod backup;
pub mod operations;
pub mod rclone_backend;
pub mod remote;
pub mod schema;

use schema::AppSettings;
use std::sync::Arc;

/// Type alias for the application's settings manager
/// Uses rcman's JsonManager convenience alias with our AppSettings schema
pub type AppSettingsManager = Arc<rcman::JsonManager<AppSettings>>;
