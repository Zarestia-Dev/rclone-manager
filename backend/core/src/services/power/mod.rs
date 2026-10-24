pub mod actions;

#[cfg(feature = "desktop")]
pub mod inhibitor;
#[cfg(feature = "desktop")]
pub use inhibitor::{PowerInhibitorState, update_power_inhibition};
