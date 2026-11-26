//! HTTP server and standalone process host.
pub(crate) use rclone_manager_core::{rclone, services, utils};
mod headless;
mod web;
pub use headless::runtime::run;
pub use web::startup::start;

mod cli;
pub use cli::HttpArgs;

/// The server's product. Its data folder, `mode` and registry key keep the name of the
/// RClone Manager Headless app it replaced, so earlier installations keep their
/// settings. Releases are tagged `server-v`, except 0.3.7, which stays `headless-v`
/// because the Headless app 0.3.6 only looks for that; the update check accepts both.
pub const PRODUCT: rclone_manager_core::context::ProductInfo =
    rclone_manager_core::context::ProductInfo {
        display_name: "RClone Manager Server",
        mode: "headless",
        release_prefixes: &["server-v", "headless-v"],
        integration_key: "RCloneManagerHeadless",
        flatpak_id: "io.github.zarestia_dev.rclone-manager.headless",
    };
