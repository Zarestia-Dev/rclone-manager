pub mod connectivity;
pub mod manager;
pub mod runtime;
pub mod state;
pub mod transport;
pub mod types;

pub mod http_transport;
pub mod routing_transport;

#[cfg(feature = "librclone")]
pub mod librclone_transport;
#[cfg(feature = "librclone")]
pub mod rclone_ffi;

pub use manager::BackendManager;
pub use transport::{BackendError, RcloneTransport, TransportKind};
