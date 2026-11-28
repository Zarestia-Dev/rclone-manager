//! HTTP server and standalone process host.
pub(crate) use rclone_manager_core::{rclone, services, utils};
mod service;
mod web;
pub use service::runtime::run;
pub use web::startup::start;

mod cli;
pub use cli::HttpArgs;

/// The server's product. Its data folder and registry key keep the name of the
/// RClone Manager Headless app it replaced, so earlier installations keep their
/// settings. Its releases are tagged `server-v`; the last `headless-v` release, 0.3.7,
/// moved the Headless app's installations to the server.
pub const PRODUCT: rclone_manager_core::context::ProductInfo =
    rclone_manager_core::context::ProductInfo {
        display_name: "RClone Manager Server",
        mode: "server",
        release_prefix: "server-v",
        integration_key: "RCloneManagerHeadless",
        flatpak_id: "io.github.zarestia_dev.rclone-manager.server",
    };
