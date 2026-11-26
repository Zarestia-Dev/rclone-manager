//! HTTP API handlers for the web server.
//!
//! This module contains all the handler functions organized by domain.

mod audio_cover;
mod common;
mod files;
mod system;
mod upload;

pub(super) use audio_cover::audio_cover_handler;
pub(super) use common::health_handler;
#[cfg(debug_assertions)]
pub(super) use common::root_handler;
pub(super) use files::{stream_file_handler, stream_remote_file_handler};
pub(super) use system::sse_handler;
pub(super) use upload::{
    MAX_LIST_BYTES, UploadSessions, add_upload_entries, cancel_upload_session,
    clear_stale_upload_staging, create_upload_session, finish_upload_session,
    legacy_upload_handler, upload_chunk, upload_session_status,
};
