//! HTTP host. This module never imports native UI or Tauri plugins.
mod access;
pub(crate) mod address;
mod auth;
mod commands;
#[cfg(not(debug_assertions))]
mod frontend;
mod handlers;
mod routes;
mod server;
pub mod startup;
mod state;

pub(crate) use state::{ApiResponse, WebServerState};
