//! HTTP API handlers for the web server.
//!
//! This module contains all the handler functions organized by domain.

mod backend;
mod backup;
mod common;
mod files;
mod flags;
mod jobs;
mod mounts;
mod remotes;
mod scheduler;
mod security;
mod settings;
mod system;
mod vfs;

pub use backend::*;
pub use backup::*;
pub use common::*;
pub use files::*;
pub use flags::*;
pub use jobs::*;
pub use mounts::*;
pub use remotes::*;
pub use scheduler::*;
pub use security::*;
pub use settings::*;
pub use system::*;
pub use vfs::*;
