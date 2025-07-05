pub mod filesystem;
pub mod flags;
pub mod mount;
pub mod remote;
pub mod stats;
pub mod system;

// Re-export all queries for easy access
pub use filesystem::*;
pub use mount::*;
pub use remote::*;
pub use stats::*;
pub use system::*;
