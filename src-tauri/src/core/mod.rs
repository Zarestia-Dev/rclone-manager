pub mod alerts;
pub mod automation;
pub mod cli;
pub mod commands;
pub mod debug;
pub mod event_listener;
pub mod initialization;
pub mod lifecycle;
pub mod paths;
pub mod security;
pub mod settings;
pub mod tray;

#[cfg(not(feature = "librclone"))]
pub mod check_binaries;
