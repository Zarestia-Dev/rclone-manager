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
    /// Tag prefixes of the product's releases, the current one first. The update check
    /// accepts them all, the release notes of this build try them in order.
    pub release_prefixes: &'static [&'static str],
    pub integration_key: &'static str,
    pub flatpak_id: &'static str,
}
