//! Global rclone bridge state shared between the extension entry point and enumerators.

use crate::bridge::RcloneBridge;
use parking_lot::Mutex;
use std::sync::Arc;

static BRIDGE: Mutex<Option<Arc<Mutex<RcloneBridge>>>> = parking_lot::const_mutex(None);

pub fn set_bridge(bridge: RcloneBridge) {
    *BRIDGE.lock() = Some(Arc::new(Mutex::new(bridge)));
}

/// Return the bridge, loading it from the shared container if not yet initialised.
pub fn get_bridge() -> Option<Arc<Mutex<RcloneBridge>>> {
    {
        let guard = BRIDGE.lock();
        if guard.is_some() {
            return guard.clone();
        }
    }
    if let Some(bridge) = RcloneBridge::load() {
        set_bridge(bridge);
    }
    BRIDGE.lock().clone()
}
