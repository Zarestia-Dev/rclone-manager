//! HTTP API handlers for the web server.
//!
//! This module contains all the handler functions organized by domain.

mod common;
mod files;
mod system;

pub use common::*;
pub use files::*;
pub use system::*;
