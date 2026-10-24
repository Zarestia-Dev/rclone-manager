//! HTTP server and standalone process host.
pub(crate) use rclone_manager_core::{rclone, services, utils};
mod headless;
mod web;
pub use headless::runtime::run;
pub use web::startup::start;

mod cli;
pub use cli::HttpArgs;

/// Metadata for the headless release family, also used by the native tray host.
pub const PRODUCT: rclone_manager_core::context::ProductInfo =
    rclone_manager_core::context::ProductInfo {
        display_name: "RClone Manager Headless",
        mode: "headless",
        release_prefix: "headless-v",
        integration_key: "RCloneManagerHeadless",
        flatpak_id: "io.github.zarestia_dev.rclone-manager.headless",
    };
