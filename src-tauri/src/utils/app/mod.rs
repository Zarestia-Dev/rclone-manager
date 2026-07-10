pub mod audio;
pub mod notification;
pub mod platform;
pub mod send_to;
pub mod ui;

#[cfg(desktop)]
pub mod builder;

#[cfg(feature = "updater")]
pub mod updater;

#[cfg(not(feature = "web-server"))]
pub mod protocol;
