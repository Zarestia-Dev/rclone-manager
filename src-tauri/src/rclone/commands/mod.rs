pub mod archive;
pub mod backend;
pub mod common;
pub mod filesystem;
pub mod job;
pub mod mount;
pub mod remote;
pub mod serve;
pub mod sync;
pub mod system;
pub mod upload;

// Mobile OAuth flow via config/oauthstatus + config/oauthstop rc endpoints.
// Desktop uses the subprocess-based ensure_oauth_process in system.rs instead.
#[cfg(feature = "librclone")]
pub mod mobile_oauth;
