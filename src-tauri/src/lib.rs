mod app;
mod core;
mod rclone;
pub mod utils;

#[cfg(feature = "web-server")]
mod server;

pub use app::run;
