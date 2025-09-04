/// Rclone Remote Control (RC) API endpoints
///
/// This module provides organized access to all rclone RC API endpoints.
/// The endpoints are categorized for easier management and discovery.
// use std::collections::HashMap;
/// Core system endpoints
pub mod core {
    pub const STATS: &str = "core/stats";
    pub const VERSION: &str = "core/version";
    pub const PID: &str = "core/pid";
    pub const QUIT: &str = "core/quit";
    pub const BWLIMIT: &str = "core/bwlimit";
    pub const MEMSTATS: &str = "core/memstats";
    pub const TRANSFERRED: &str = "core/transferred";
    // pub const COMMAND: &str = "core/command";
    // pub const DU: &str = "core/du";
    // pub const GC: &str = "core/gc";
    // pub const GROUP_LIST: &str = "core/group-list";
    // pub const OBSCURE: &str = "core/obscure";
    // pub const STATS_DELETE: &str = "core/stats-delete";
    // pub const STATS_RESET: &str = "core/stats-reset";
}

/// Configuration management endpoints
pub mod config {
    pub const DUMP: &str = "config/dump";
    pub const GET: &str = "config/get";
    pub const CREATE: &str = "config/create";
    pub const UPDATE: &str = "config/update";
    pub const DELETE: &str = "config/delete";
    pub const LISTREMOTES: &str = "config/listremotes";
    pub const PROVIDERS: &str = "config/providers";
    // pub const PASSWORD: &str = "config/password";
    pub const PATHS: &str = "config/paths";
    pub const SETPATH: &str = "config/setpath";
    // pub const UNLOCK: &str = "config/unlock";
}

/// Job management endpoints
pub mod job {
    // pub const LIST: &str = "job/list";
    pub const STATUS: &str = "job/status";
    pub const STOP: &str = "job/stop";
    // pub const STOPGROUP: &str = "job/stopgroup";
}

/// Mount operations endpoints
pub mod mount {
    pub const MOUNT: &str = "mount/mount";
    pub const UNMOUNT: &str = "mount/unmount";
    pub const UNMOUNTALL: &str = "mount/unmountall";
    pub const LISTMOUNTS: &str = "mount/listmounts";
    pub const TYPES: &str = "mount/types";
}

/// File operations endpoints
pub mod operations {
    pub const ABOUT: &str = "operations/about";
    // pub const CHECK: &str = "operations/check";
    // pub const CLEANUP: &str = "operations/cleanup";
    // pub const COPYFILE: &str = "operations/copyfile";
    // pub const COPYURL: &str = "operations/copyurl";
    // pub const DELETE: &str = "operations/delete";
    // pub const DELETEFILE: &str = "operations/deletefile";
    pub const FSINFO: &str = "operations/fsinfo";
    // pub const HASHSUM: &str = "operations/hashsum";
    pub const LIST: &str = "operations/list";
    // pub const MKDIR: &str = "operations/mkdir";
    // pub const MOVEFILE: &str = "operations/movefile";
    // pub const PUBLICLINK: &str = "operations/publiclink";
    // pub const PURGE: &str = "operations/purge";
    // pub const RMDIR: &str = "operations/rmdir";
    // pub const RMDIRS: &str = "operations/rmdirs";
    // pub const SIZE: &str = "operations/size";
    // pub const STAT: &str = "operations/stat";
    // pub const UPLOADFILE: &str = "operations/uploadfile";
}

/// Synchronization endpoints
pub mod sync {
    pub const SYNC: &str = "sync/sync";
    pub const COPY: &str = "sync/copy";
    pub const BISYNC: &str = "sync/bisync";
    pub const MOVE: &str = "sync/move";
}

// /// Virtual File System (VFS) endpoints
// pub mod vfs {
//     pub const FORGET: &str = "vfs/forget";
//     pub const POLL_INTERVAL: &str = "vfs/poll-interval";
//     pub const REFRESH: &str = "vfs/refresh";
//     pub const STATS: &str = "vfs/stats";
// }

// /// Backend command endpoints
// pub mod backend {
//     pub const COMMAND: &str = "backend/command";
// }

// /// Debug endpoints
// pub mod debug {
//     pub const SET_BLOCK_PROFILE_RATE: &str = "debug/set-block-profile-rate";
//     pub const SET_GC_PERCENT: &str = "debug/set-gc-percent";
//     pub const SET_MUTEX_PROFILE_FRACTION: &str = "debug/set-mutex-profile-fraction";
//     pub const SET_SOFT_MEMORY_LIMIT: &str = "debug/set-soft-memory-limit";
// }

// /// File system cache endpoints
// pub mod fscache {
//     pub const CLEAR: &str = "fscache/clear";
//     pub const ENTRIES: &str = "fscache/entries";
// }

// /// Option management endpoints
// pub mod options {
//     pub const BLOCKS: &str = "options/blocks";
//     pub const GET: &str = "options/get";
//     pub const INFO: &str = "options/info";
//     pub const SET: &str = "options/set";
// }

// /// Plugin control endpoints
// pub mod pluginsctl {
//     pub const ADD_PLUGIN: &str = "pluginsctl/addPlugin";
//     pub const GET_PLUGINS_FOR_TYPE: &str = "pluginsctl/getPluginsForType";
//     pub const LIST_PLUGINS: &str = "pluginsctl/listPlugins";
//     pub const LIST_TEST_PLUGINS: &str = "pluginsctl/listTestPlugins";
//     pub const REMOVE_PLUGIN: &str = "pluginsctl/removePlugin";
//     pub const REMOVE_TEST_PLUGIN: &str = "pluginsctl/removeTestPlugin";
// }

// /// Remote control endpoints
// pub mod rc {
//     pub const ERROR: &str = "rc/error";
//     pub const LIST: &str = "rc/list";
//     pub const NOOP: &str = "rc/noop";
//     pub const NOOPAUTH: &str = "rc/noopauth";
//     pub const PID: &str = "rc/pid";
// }

/// Endpoint utilities and helpers
pub struct EndpointHelper;

impl EndpointHelper {
    /// Build a full URL for an endpoint
    pub fn build_url(base_url: &str, endpoint: &str) -> String {
        format!("{}/{}", base_url.trim_end_matches('/'), endpoint)
    }

    // /// Get all endpoints as a flat list for discovery
    // pub fn get_all_endpoints() -> Vec<&'static str> {
    //     vec![
    //         // Core endpoints
    //         core::STATS, core::VERSION, core::PID, core::QUIT, core::BWLIMIT,
    //         core::MEMSTATS, core::TRANSFERRED, core::COMMAND, core::DU, core::GC,
    //         core::GROUP_LIST, core::OBSCURE, core::STATS_DELETE, core::STATS_RESET,

    //         // Config endpoints
    //         config::DUMP, config::GET, config::CREATE, config::UPDATE, config::DELETE,
    //         config::LISTREMOTES, config::PROVIDERS, config::PASSWORD, config::PATHS,
    //         config::SETPATH,

    //         // Job endpoints
    //         job::LIST, job::STATUS, job::STOP, job::STOPGROUP,

    //         // Mount endpoints
    //         mount::MOUNT, mount::UNMOUNT, mount::UNMOUNTALL, mount::LISTMOUNTS, mount::TYPES,

    //         // Operations endpoints
    //         operations::ABOUT, operations::CHECK, operations::CLEANUP, operations::COPYFILE,
    //         operations::COPYURL, operations::DELETE, operations::DELETEFILE, operations::FSINFO,
    //         operations::HASHSUM, operations::LIST, operations::MKDIR, operations::MOVEFILE,
    //         operations::PUBLICLINK, operations::PURGE, operations::RMDIR, operations::RMDIRS,
    //         operations::SIZE, operations::STAT, operations::UPLOADFILE,

    //         // Sync endpoints
    //         sync::SYNC, sync::COPY, sync::MOVE,

    //         // VFS endpoints
    //         vfs::FORGET, vfs::POLL_INTERVAL, vfs::REFRESH, vfs::STATS,

    //         // Backend endpoints
    //         backend::COMMAND,

    //         // Debug endpoints
    //         debug::SET_BLOCK_PROFILE_RATE, debug::SET_GC_PERCENT,
    //         debug::SET_MUTEX_PROFILE_FRACTION, debug::SET_SOFT_MEMORY_LIMIT,

    //         // FS Cache endpoints
    //         fscache::CLEAR, fscache::ENTRIES,

    //         // Options endpoints
    //         options::BLOCKS, options::GET, options::INFO, options::SET,

    //         // Plugins endpoints
    //         pluginsctl::ADD_PLUGIN, pluginsctl::GET_PLUGINS_FOR_TYPE,
    //         pluginsctl::LIST_PLUGINS, pluginsctl::LIST_TEST_PLUGINS,
    //         pluginsctl::REMOVE_PLUGIN, pluginsctl::REMOVE_TEST_PLUGIN,

    //         // RC endpoints
    //         rc::ERROR, rc::LIST, rc::NOOP, rc::NOOPAUTH, rc::PID,
    //     ]
    // }

    // /// Get endpoints grouped by category
    // pub fn get_endpoints_by_category() -> HashMap<&'static str, Vec<&'static str>> {
    //     let mut categories = HashMap::new();

    //     categories.insert("core", vec![
    //         core::STATS, core::VERSION, core::PID, core::QUIT, core::BWLIMIT,
    //         core::MEMSTATS, core::TRANSFERRED, core::COMMAND, core::DU, core::GC,
    //         core::GROUP_LIST, core::OBSCURE, core::STATS_DELETE, core::STATS_RESET,
    //     ]);

    //     categories.insert("config", vec![
    //         config::DUMP, config::GET, config::CREATE, config::UPDATE, config::DELETE,
    //         config::LISTREMOTES, config::PROVIDERS, config::PASSWORD, config::PATHS,
    //         config::SETPATH,
    //     ]);

    //     categories.insert("job", vec![
    //         job::LIST, job::STATUS, job::STOP, job::STOPGROUP,
    //     ]);

    //     categories.insert("mount", vec![
    //         mount::MOUNT, mount::UNMOUNT, mount::UNMOUNTALL, mount::LISTMOUNTS, mount::TYPES,
    //     ]);

    //     categories.insert("operations", vec![
    //         operations::ABOUT, operations::CHECK, operations::CLEANUP, operations::COPYFILE,
    //         operations::COPYURL, operations::DELETE, operations::DELETEFILE, operations::FSINFO,
    //         operations::HASHSUM, operations::LIST, operations::MKDIR, operations::MOVEFILE,
    //         operations::PUBLICLINK, operations::PURGE, operations::RMDIR, operations::RMDIRS,
    //         operations::SIZE, operations::STAT, operations::UPLOADFILE,
    //     ]);

    //     categories.insert("sync", vec![
    //         sync::SYNC, sync::COPY, sync::MOVE,
    //     ]);

    //     categories.insert("vfs", vec![
    //         vfs::FORGET, vfs::POLL_INTERVAL, vfs::REFRESH, vfs::STATS,
    //     ]);

    //     categories.insert("backend", vec![
    //         backend::COMMAND,
    //     ]);

    //     categories.insert("debug", vec![
    //         debug::SET_BLOCK_PROFILE_RATE, debug::SET_GC_PERCENT,
    //         debug::SET_MUTEX_PROFILE_FRACTION, debug::SET_SOFT_MEMORY_LIMIT,
    //     ]);

    //     categories.insert("fscache", vec![
    //         fscache::CLEAR, fscache::ENTRIES,
    //     ]);

    //     categories.insert("options", vec![
    //         options::BLOCKS, options::GET, options::INFO, options::SET,
    //     ]);

    //     categories.insert("pluginsctl", vec![
    //         pluginsctl::ADD_PLUGIN, pluginsctl::GET_PLUGINS_FOR_TYPE,
    //         pluginsctl::LIST_PLUGINS, pluginsctl::LIST_TEST_PLUGINS,
    //         pluginsctl::REMOVE_PLUGIN, pluginsctl::REMOVE_TEST_PLUGIN,
    //     ]);

    //     categories.insert("rc", vec![
    //         rc::ERROR, rc::LIST, rc::NOOP, rc::NOOPAUTH, rc::PID,
    //     ]);

    //     categories
    // }

    // /// Check if an endpoint exists
    // pub fn endpoint_exists(endpoint: &str) -> bool {
    //     Self::get_all_endpoints().contains(&endpoint)
    // }

    // /// Get category for an endpoint
    // pub fn get_endpoint_category(endpoint: &str) -> Option<&'static str> {
    //     if let Some(category) = endpoint.split('/').next() {
    //         match category {
    //             "core" => Some("core"),
    //             "config" => Some("config"),
    //             "job" => Some("job"),
    //             "mount" => Some("mount"),
    //             "operations" => Some("operations"),
    //             "sync" => Some("sync"),
    //             "vfs" => Some("vfs"),
    //             "backend" => Some("backend"),
    //             "debug" => Some("debug"),
    //             "fscache" => Some("fscache"),
    //             "options" => Some("options"),
    //             "pluginsctl" => Some("pluginsctl"),
    //             "rc" => Some("rc"),
    //             _ => None,
    //         }
    //     } else {
    //         None
    //     }
    // }
}
