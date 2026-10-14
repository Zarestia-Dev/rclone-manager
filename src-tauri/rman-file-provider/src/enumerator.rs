//! `NSFileProviderEnumerator` ObjC class and pure-Rust enumeration logic.

use crate::bridge::RcloneBridge;
use crate::item::{FileProviderItemData, RustFileProviderItem};
use crate::state::get_bridge;
use block2::Block;
use objc2::define_class;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, NSObject};
use objc2::{class, msg_send, AnyThread, DefinedClass};
use objc2_foundation::NSString;

// ── Pure-Rust enumeration logic (testable without ObjC) ──────────────────────

pub struct EnumeratedItem {
    pub identifier: String,
    pub parent_identifier: String,
    pub filename: String,
    pub is_directory: bool,
    pub size: i64,
    pub mod_time: Option<i64>,
}

pub struct FileProviderEnumerator {
    container_id: String,
    server_url: String,
}

impl FileProviderEnumerator {
    pub fn new(container_id: &str) -> Self {
        let server_url = if container_id == ROOT_CONTAINER_ID {
            String::new()
        } else {
            crate::item::identifier_to_path(container_id).unwrap_or_default()
        };
        Self {
            container_id: container_id.to_string(),
            server_url,
        }
    }

    pub fn enumerate_items(
        &self,
        bridge: &RcloneBridge,
        page: Option<&str>,
    ) -> (Vec<EnumeratedItem>, bool, Option<String>) {
        if self.container_id == ROOT_CONTAINER_ID {
            return self.enumerate_remotes(bridge);
        }
        if self.server_url.is_empty() {
            return (vec![], false, None);
        }
        self.enumerate_directory(bridge, &self.server_url, page)
    }

    fn enumerate_remotes(
        &self,
        bridge: &RcloneBridge,
    ) -> (Vec<EnumeratedItem>, bool, Option<String>) {
        let items = bridge
            .list_remotes()
            .into_iter()
            .map(|name| {
                let safe_path = format!("{}:", name);
                EnumeratedItem {
                    identifier: crate::item::path_to_identifier(&safe_path),
                    parent_identifier: ROOT_CONTAINER_ID.to_string(),
                    filename: name,
                    is_directory: true,
                    size: 0,
                    mod_time: None,
                }
            })
            .collect();
        (items, false, None)
    }

    fn enumerate_directory(
        &self,
        bridge: &RcloneBridge,
        path: &str,
        _page: Option<&str>,
    ) -> (Vec<EnumeratedItem>, bool, Option<String>) {
        let items = bridge
            .list(path)
            .into_iter()
            .map(|entry| {
                let full_path = format!("{}/{}", path.trim_end_matches(':'), entry.name);
                EnumeratedItem {
                    identifier: crate::item::path_to_identifier(&full_path),
                    parent_identifier: self.container_id.clone(),
                    filename: entry.name,
                    is_directory: entry.is_dir,
                    size: entry.size,
                    mod_time: entry.mod_time,
                }
            })
            .collect();
        (items, false, None)
    }

    /// No change tracking for v1 — signal via NSFileProviderManager.signalEnumerator instead.
    #[allow(dead_code)]
    pub fn enumerate_changes(
        &self,
        _bridge: &RcloneBridge,
        _anchor: &str,
    ) -> (Vec<String>, Vec<EnumeratedItem>, Option<String>) {
        (vec![], vec![], None)
    }
}

const ROOT_CONTAINER_ID: &str = crate::item::ROOT_CONTAINER_ID;

// ── ObjC class ───────────────────────────────────────────────────────────────

pub(crate) struct EnumeratorIvars {
    container_id: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "RustFileProviderEnumerator"]
    #[ivars = EnumeratorIvars]
    pub(crate) struct RustFileProviderEnumerator;

    impl RustFileProviderEnumerator {
        #[unsafe(method_id(init))]
        fn init(this: Allocated<Self>) -> Option<Retained<Self>> {
            let this = this.set_ivars(EnumeratorIvars {
                container_id: String::new(),
            });
            unsafe { msg_send![super(this), init] }
        }

        #[unsafe(method(enumerateItemsForObserver:startingAtPage:))]
        fn enumerate_items_for_observer(
            &self,
            observer: *mut AnyObject,
            _page: *mut AnyObject,
        ) {
            let container_id = self.ivars().container_id.clone();

            let Some(arc) = get_bridge() else {
                unsafe {
                    let err = make_fp_error("rclone bridge not loaded");
                    let _: () = msg_send![observer, finishEnumeratingWithError: err];
                }
                return;
            };

            let bridge = arc.lock();
            let enumerator = FileProviderEnumerator::new(&container_id);
            let (items, _has_more, _) = enumerator.enumerate_items(&bridge, None);

            unsafe {
                let array: *mut AnyObject = msg_send![class!(NSMutableArray), array];
                for item in items {
                    let obj = RustFileProviderItem::new(FileProviderItemData {
                        identifier: item.identifier,
                        parent_identifier: item.parent_identifier,
                        filename: item.filename,
                        is_dir: item.is_directory,
                        size: item.size,
                        mod_time: item.mod_time,
                    });
                    let raw = Retained::into_raw(obj);
                    let _: () = msg_send![array, addObject: raw];
                    // array retained it; release our +1
                    let _: () = msg_send![raw, release];
                }
                let _: () = msg_send![observer, didEnumerateItems: array];
                // nil page = no more pages
                let _: () = msg_send![
                    observer,
                    finishEnumeratingUpToPage: std::ptr::null_mut::<AnyObject>()
                ];
            }
        }

        #[unsafe(method(enumerateChangesForObserver:fromSyncAnchor:))]
        fn enumerate_changes_for_observer(
            &self,
            observer: *mut AnyObject,
            _anchor: *mut AnyObject,
        ) {
            // No change tracking in v1 — report empty changeset with a fresh anchor.
            unsafe {
                let empty: *mut AnyObject = msg_send![class!(NSMutableArray), array];
                let _: () = msg_send![observer, didDeleteItemsWithIdentifiers: empty];
                let _: () = msg_send![observer, didUpdateItems: empty];
                let anchor: *mut AnyObject = msg_send![class!(NSData), data];
                let more: bool = false;
                let _: () = msg_send![
                    observer,
                    finishEnumeratingChangesUpToSyncAnchor: anchor,
                    moreComing: more
                ];
            }
        }

        #[unsafe(method(currentSyncAnchorWithCompletionHandler:))]
        fn current_sync_anchor(&self, completion_handler: *mut AnyObject) {
            unsafe {
                let anchor: *mut AnyObject = msg_send![class!(NSData), data];
                if !completion_handler.is_null() {
                    let block: &Block<dyn Fn(*mut AnyObject)> =
                        &*(completion_handler as *const Block<dyn Fn(*mut AnyObject)>);
                    block.call((anchor,));
                }
            }
        }

        #[unsafe(method(invalidate))]
        fn invalidate(&self) {}
    }
);

impl RustFileProviderEnumerator {
    pub fn new(container_id: &str) -> Retained<Self> {
        let this = Self::alloc().set_ivars(EnumeratorIvars {
            container_id: container_id.to_string(),
        });
        unsafe { msg_send![super(this), init] }
    }
}

fn make_fp_error(message: &str) -> *mut AnyObject {
    unsafe {
        let domain = NSString::from_str("com.rclone.manager.fileprovider");
        let code: i64 = -1;
        let key = NSString::from_str("NSLocalizedDescriptionKey");
        let desc = NSString::from_str(message);
        let user_info: *mut AnyObject =
            msg_send![class!(NSDictionary), dictionaryWithObject: &*desc, forKey: &*key];
        msg_send![class!(NSError), errorWithDomain: &*domain, code: code, userInfo: user_info]
    }
}
