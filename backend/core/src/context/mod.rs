//! Runtime-independent application state and host capabilities.
mod host;
mod state;
pub use host::{ExitDecision, Host};
pub use state::{AppHandle, State};

/// Immutable product metadata supplied once by the executable.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProductInfo {
    pub display_name: &'static str,
    pub mode: &'static str,
    /// Tag prefix of the product's releases (`v`, `server-v`).
    pub release_prefix: &'static str,
    pub integration_key: &'static str,
    pub flatpak_id: &'static str,
}
