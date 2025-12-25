//! Backup and restore module for rcman

mod archive;
mod operations;
mod restore;
mod types;

pub use operations::BackupManager;
pub use restore::RestoreResult;
pub use types::*;
