pub mod actions;

pub use actions::execute_system_power;

#[cfg(all(
    feature = "desktop",
    not(any(target_os = "android", target_os = "ios"))
))]
pub mod inhibitor;

#[cfg(all(
    feature = "desktop",
    not(any(target_os = "android", target_os = "ios"))
))]
pub use inhibitor::{PowerInhibitorState, update_power_inhibition};
