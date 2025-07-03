pub mod remote;
pub mod mount;
pub mod filesystem;
pub mod system;
pub mod stats;
pub mod flags;

// Re-export all queries for easy access
pub use remote::*;
pub use mount::*;
pub use filesystem::*;
pub use system::*;
pub use stats::*;