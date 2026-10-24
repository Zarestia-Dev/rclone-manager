//! HTTP API handlers for the web server.
//!
//! This module contains all the handler functions organized by domain.

mod audio_cover;
mod common;
mod files;
mod system;
mod upload;

pub use audio_cover::*;
pub use common::*;
pub use files::*;
pub use system::*;
pub use upload::*;
