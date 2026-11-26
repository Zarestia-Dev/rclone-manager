//! Desktop window integration.
pub(crate) mod window;

pub(crate) mod debug;

#[cfg(any(autostart_plugin, autostart_portal))]
pub(crate) mod autostart;
#[cfg(target_os = "linux")]
pub(crate) mod graphics;

#[cfg(feature = "portable")]
pub(crate) mod paths;
