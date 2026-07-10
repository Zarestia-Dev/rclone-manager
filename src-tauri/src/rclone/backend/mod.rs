pub mod connectivity;
pub mod http_transport;
pub mod manager;
pub mod routing_transport;
pub mod runtime;
pub mod state;
pub mod transport;
pub mod types;

#[cfg(feature = "librclone")]
pub mod librclone_transport;
#[cfg(feature = "librclone")]
pub mod rclone_ffi;

pub use manager::BackendManager;
pub use transport::{BackendError, RcloneTransport, TransportKind};
