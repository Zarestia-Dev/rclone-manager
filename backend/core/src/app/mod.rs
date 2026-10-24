//! Shared application bootstrap and command contract.
pub mod commands;
pub mod send_to;
mod setup;
pub use setup::setup_context;
pub mod dispatch;
