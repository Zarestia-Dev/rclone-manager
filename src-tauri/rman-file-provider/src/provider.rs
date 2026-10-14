//! `NSFileProviderExtension` subclass defined with `define_class!`.

use block2::Block;
use objc2::define_class;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{class, msg_send};
use objc2_file_provider::NSFileProviderExtension;
use objc2_foundation::NSString;

use crate::bridge::RcloneBridge;
use crate::enumerator::RustFileProviderEnumerator;
use crate::item::{
    nsstring_to_str, FileProviderItemData, RustFileProviderItem, ROOT_CONTAINER_ID,
};
use crate::state::get_bridge;

define_class!(
    #[unsafe(super(NSFileProviderExtension, NSObject))]
    #[name = "RustFileProviderExtension"]
    pub(crate) struct RustFileProviderExtension;

    impl RustFileProviderExtension {
        #[unsafe(method(itemForIdentifier:error:))]
        fn item_for_identifier(
            &self,
            identifier: *const AnyObject,
            _error: *mut *mut AnyObject,
        ) -> *mut AnyObject {
            let id_str = obj_to_nsstring(identifier);
            let id = nsstring_to_str(id_str);

            if crate::item::is_root_identifier(id_str) {
                return make_root_item();
            }

            let Some(arc) = get_bridge() else {
                return std::ptr::null_mut();
            };
            let bridge = arc.lock();

            match crate::item::identifier_to_path(id)
                .and_then(|p| bridge.stat(&p).ok())
            {
                Some(stat) => {
                    let item = RustFileProviderItem::new(FileProviderItemData {
                        identifier: id.to_string(),
                        parent_identifier: crate::item::path_to_identifier(
                            std::path::Path::new(id)
                                .parent()
                                .and_then(|p| p.to_str())
                                .unwrap_or(ROOT_CONTAINER_ID),
                        ),
                        filename: stat.name,
                        is_dir: stat.is_dir,
                        size: stat.size,
                        mod_time: stat.mod_time,
                    });
                    Retained::into_raw(item) as *mut AnyObject
                }
                None => std::ptr::null_mut(),
            }
        }

        #[unsafe(method(enumeratorForContainerItemIdentifier:error:))]
        fn enumerator_for_container(
            &self,
            container_identifier: *const AnyObject,
            _error: *mut *mut AnyObject,
        ) -> *mut AnyObject {
            let id_str = obj_to_nsstring(container_identifier);
            let container_id = nsstring_to_str(id_str);
            let enumerator = RustFileProviderEnumerator::new(container_id);
            Retained::into_raw(enumerator) as *mut AnyObject
        }

        #[unsafe(method(startProvidingItemAtURL:completionHandler:))]
        fn start_providing_item(
            &self,
            url: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            let Some(arc) = get_bridge() else {
                call_completion(completion_handler, None);
                return;
            };
            let bridge = arc.lock();
            let url_str: Retained<NSString> = unsafe { msg_send![url, path] };
            let url_path = nsstring_to_str(&url_str).to_string();
            let remote_path = local_path_to_remote(&url_path);
            match bridge.download(&remote_path, std::path::Path::new(&url_path)) {
                Ok(()) => call_completion(completion_handler, None),
                Err(e) => {
                    log::error!("startProvidingItem: {e}");
                    call_completion(completion_handler, Some(make_nserror(&e)));
                }
            }
        }

        #[unsafe(method(stopProvidingItemAtURL:))]
        fn stop_providing_item(&self, _url: *const AnyObject) {}

        #[unsafe(method(providePlaceholderAtURL:completionHandler:))]
        fn provide_placeholder(
            &self,
            url: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            let url_str: Retained<NSString> = unsafe { msg_send![url, path] };
            let path = nsstring_to_str(&url_str).to_string();
            let filename = std::path::Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();

            let item = RustFileProviderItem::new(FileProviderItemData {
                identifier: crate::item::path_to_identifier(&path),
                parent_identifier: crate::item::path_to_identifier(
                    std::path::Path::new(&path)
                        .parent()
                        .and_then(|p| p.to_str())
                        .unwrap_or(ROOT_CONTAINER_ID),
                ),
                filename,
                is_dir: false,
                size: 0,
                mod_time: None,
            });

            unsafe {
                let placeholder_url: *mut AnyObject =
                    msg_send![class!(NSFileProviderManager), placeholderURLForURL: url];
                let raw_item = Retained::as_ptr(&item);
                let mut error: *mut AnyObject = std::ptr::null_mut();
                let ok: bool = msg_send![
                    class!(NSFileProviderManager),
                    writePlaceholderAtURL: placeholder_url,
                    withMetadata: raw_item,
                    error: &mut error
                ];
                if ok {
                    call_completion(completion_handler, None);
                } else {
                    let err = if error.is_null() {
                        make_nserror("writePlaceholderAtURL failed")
                    } else {
                        error
                    };
                    call_completion(completion_handler, Some(err));
                }
            }
        }

        #[unsafe(method(createDirectoryWithName:inParentItemIdentifier:completionHandler:))]
        fn create_directory(
            &self,
            directory_name: *const AnyObject,
            parent_identifier: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            let Some(arc) = get_bridge() else {
                call_completion_with_item(completion_handler, std::ptr::null_mut(), None);
                return;
            };
            let bridge = arc.lock();
            let parent_str = obj_to_nsstring(parent_identifier);
            let dir_name_str = obj_to_nsstring(directory_name);
            let parent_path = crate::item::identifier_to_path(nsstring_to_str(parent_str))
                .unwrap_or_default();
            let dir_name = nsstring_to_str(dir_name_str).to_string();
            let remote_path =
                format!("{}/{}", parent_path.trim_end_matches(':'), dir_name);
            match bridge.mkdir(&remote_path) {
                Ok(()) => {
                    let item = RustFileProviderItem::new(FileProviderItemData {
                        identifier: crate::item::path_to_identifier(&remote_path),
                        parent_identifier: nsstring_to_str(parent_str).to_string(),
                        filename: dir_name,
                        is_dir: true,
                        size: 0,
                        mod_time: None,
                    });
                    let raw = Retained::into_raw(item) as *mut AnyObject;
                    call_completion_with_item(completion_handler, raw, None);
                    unsafe { let _: () = msg_send![raw, release]; }
                }
                Err(e) => call_completion_with_item(
                    completion_handler,
                    std::ptr::null_mut(),
                    Some(make_nserror(&e)),
                ),
            }
        }

        #[unsafe(method(renameItemWithIdentifier:toName:completionHandler:))]
        fn rename_item(
            &self,
            item_identifier: *const AnyObject,
            item_name: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            let Some(arc) = get_bridge() else {
                call_completion_with_item(completion_handler, std::ptr::null_mut(), None);
                return;
            };
            let bridge = arc.lock();
            let id_str = obj_to_nsstring(item_identifier);
            let name_str = obj_to_nsstring(item_name);
            let remote_path =
                crate::item::identifier_to_path(nsstring_to_str(id_str)).unwrap_or_default();
            let parent = std::path::Path::new(&remote_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or("");
            let new_name = nsstring_to_str(name_str).to_string();
            let new_path = format!("{}/{}", parent.trim_end_matches(':'), new_name);
            let body = serde_json::json!({ "sourceFs": remote_path, "destFs": new_path });
            match bridge.post("operations/moveto", &body) {
                Ok(_) => {
                    let item = RustFileProviderItem::new(FileProviderItemData {
                        identifier: crate::item::path_to_identifier(&new_path),
                        parent_identifier: nsstring_to_str(id_str).to_string(),
                        filename: new_name,
                        is_dir: false,
                        size: 0,
                        mod_time: None,
                    });
                    let raw = Retained::into_raw(item) as *mut AnyObject;
                    call_completion_with_item(completion_handler, raw, None);
                    unsafe { let _: () = msg_send![raw, release]; }
                }
                Err(e) => call_completion_with_item(
                    completion_handler,
                    std::ptr::null_mut(),
                    Some(make_nserror(&e)),
                ),
            }
        }

        #[unsafe(method(deleteItemWithIdentifier:completionHandler:))]
        fn delete_item(
            &self,
            item_identifier: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            let Some(arc) = get_bridge() else {
                call_completion(completion_handler, None);
                return;
            };
            let bridge = arc.lock();
            let id_str = obj_to_nsstring(item_identifier);
            let remote_path =
                crate::item::identifier_to_path(nsstring_to_str(id_str)).unwrap_or_default();
            match bridge.delete(&remote_path) {
                Ok(()) => call_completion(completion_handler, None),
                Err(e) => call_completion(completion_handler, Some(make_nserror(&e))),
            }
        }

        #[unsafe(method(importDocumentAtURL:toParentItemIdentifier:completionHandler:))]
        fn import_document(
            &self,
            file_url: *const AnyObject,
            parent_identifier: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            let Some(arc) = get_bridge() else {
                call_completion_with_item(completion_handler, std::ptr::null_mut(), None);
                return;
            };
            let bridge = arc.lock();
            let parent_str = obj_to_nsstring(parent_identifier);
            let file_path_str: Retained<NSString> = unsafe { msg_send![file_url, path] };
            let parent_path = crate::item::identifier_to_path(nsstring_to_str(parent_str))
                .unwrap_or_default();
            let local_path = nsstring_to_str(&file_path_str).to_string();
            let filename = std::path::Path::new(&local_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            let remote_path =
                format!("{}/{}", parent_path.trim_end_matches(':'), filename);
            match bridge.upload(&remote_path, std::path::Path::new(&local_path)) {
                Ok(()) => {
                    let item = RustFileProviderItem::new(FileProviderItemData {
                        identifier: crate::item::path_to_identifier(&remote_path),
                        parent_identifier: nsstring_to_str(parent_str).to_string(),
                        filename,
                        is_dir: false,
                        size: 0,
                        mod_time: None,
                    });
                    let raw = Retained::into_raw(item) as *mut AnyObject;
                    call_completion_with_item(completion_handler, raw, None);
                    unsafe { let _: () = msg_send![raw, release]; }
                }
                Err(e) => call_completion_with_item(
                    completion_handler,
                    std::ptr::null_mut(),
                    Some(make_nserror(&e)),
                ),
            }
        }

        #[unsafe(method(itemChangedAtURL:))]
        fn item_changed(&self, url: *const AnyObject) {
            let Some(arc) = get_bridge() else { return };
            let bridge = arc.lock();
            let url_str: Retained<NSString> = unsafe { msg_send![url, path] };
            let local_path = nsstring_to_str(&url_str).to_string();
            let remote_path = local_path_to_remote(&local_path);
            let _ = bridge.upload(&remote_path, std::path::Path::new(&local_path));
        }

        #[unsafe(method(setLastUsedDate:forItemIdentifier:completionHandler:))]
        fn set_last_used_date(
            &self,
            _date: *mut AnyObject,
            _item_identifier: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            call_completion_with_item(completion_handler, std::ptr::null_mut(), None);
        }

        #[unsafe(method(setTagData:forItemIdentifier:completionHandler:))]
        fn set_tag_data(
            &self,
            _tag_data: *mut AnyObject,
            _item_identifier: *const AnyObject,
            completion_handler: *mut AnyObject,
        ) {
            call_completion_with_item(completion_handler, std::ptr::null_mut(), None);
        }
    }
);

// ── Helper functions ──────────────────────────────────────────────────────────

fn obj_to_nsstring<'a>(obj: *const AnyObject) -> &'a NSString {
    // SAFETY: callers guarantee obj is a live NSString for lifetime 'a
    unsafe { &*(obj as *const NSString) }
}

fn make_root_item() -> *mut AnyObject {
    let item = RustFileProviderItem::new(FileProviderItemData {
        identifier: ROOT_CONTAINER_ID.to_string(),
        parent_identifier: ROOT_CONTAINER_ID.to_string(),
        filename: "rclone remotes".to_string(),
        is_dir: true,
        size: 0,
        mod_time: None,
    });
    Retained::into_raw(item) as *mut AnyObject
}

fn call_completion(block_ptr: *mut AnyObject, error: Option<*mut AnyObject>) {
    if block_ptr.is_null() {
        return;
    }
    unsafe {
        let block: &Block<dyn Fn(*mut AnyObject)> =
            &*(block_ptr as *const Block<dyn Fn(*mut AnyObject)>);
        block.call((error.unwrap_or(std::ptr::null_mut()),));
    }
}

fn call_completion_with_item(
    block_ptr: *mut AnyObject,
    item: *mut AnyObject,
    error: Option<*mut AnyObject>,
) {
    if block_ptr.is_null() {
        return;
    }
    unsafe {
        let block: &Block<dyn Fn(*mut AnyObject, *mut AnyObject)> =
            &*(block_ptr as *const Block<dyn Fn(*mut AnyObject, *mut AnyObject)>);
        block.call((item, error.unwrap_or(std::ptr::null_mut())));
    }
}

fn make_nserror(message: &str) -> *mut AnyObject {
    unsafe {
        let domain = NSString::from_str("com.rclone.manager.fileprovider");
        let code: i64 = -1;
        let desc_key = NSString::from_str("NSLocalizedDescriptionKey");
        let desc = NSString::from_str(message);
        let user_info: *mut AnyObject =
            msg_send![class!(NSDictionary), dictionaryWithObject: &*desc, forKey: &*desc_key];
        msg_send![class!(NSError), errorWithDomain: &*domain, code: code, userInfo: user_info]
    }
}

fn local_path_to_remote(local: &str) -> String {
    if let Ok(home) = std::env::var("HOME") {
        let prefix = format!("{}/Library/Caches", home);
        local
            .strip_prefix(&prefix)
            .unwrap_or(local)
            .trim_start_matches('/')
            .to_string()
    } else {
        local.to_string()
    }
}
