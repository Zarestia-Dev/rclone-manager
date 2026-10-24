//! HTTP host. This module never imports native UI or Tauri plugins.
pub(crate) mod address;
mod auth;
mod commands;
#[cfg(not(debug_assertions))]
mod frontend;
mod handlers;
#[cfg(debug_assertions)]
mod paths;
mod routes;
mod server;
pub mod startup;
mod state;

pub(crate) use state::{ApiResponse, WebServerState};
mod access;
