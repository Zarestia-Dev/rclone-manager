//! `NSFileProviderItem` ObjC class and identifier helpers.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use objc2::define_class;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, NSObject};
use objc2::{class, msg_send, AnyThread, DefinedClass};
use objc2_foundation::{NSNumber, NSString};

pub const FOLDER_TYPE_ID: &str = "public.folder";
pub const FILE_TYPE_ID: &str = "public.data";
pub const ROOT_CONTAINER_ID: &str = "NSFileProviderRootContainerItemIdentifier";

pub struct FileProviderItemData {
    pub identifier: String,
    pub parent_identifier: String,
    pub filename: String,
    pub is_dir: bool,
    pub size: i64,
    pub mod_time: Option<i64>,
}

pub(crate) struct ItemIvars {
    identifier: String,
    parent_identifier: String,
    filename: String,
    is_dir: bool,
    size: i64,
    mod_time: Option<i64>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "RustFileProviderItem"]
    #[ivars = ItemIvars]
    pub(crate) struct RustFileProviderItem;

    impl RustFileProviderItem {
        // Default init required by define_class! — real construction goes through new().
        #[unsafe(method_id(init))]
        fn init(this: Allocated<Self>) -> Option<Retained<Self>> {
            let this = this.set_ivars(ItemIvars {
                identifier: String::new(),
                parent_identifier: String::new(),
                filename: String::new(),
                is_dir: false,
                size: 0,
                mod_time: None,
            });
            unsafe { msg_send![super(this), init] }
        }

        #[unsafe(method_id(itemIdentifier))]
        fn item_identifier(&self) -> Retained<NSString> {
            NSString::from_str(&self.ivars().identifier)
        }

        #[unsafe(method_id(parentItemIdentifier))]
        fn parent_item_identifier(&self) -> Retained<NSString> {
            NSString::from_str(&self.ivars().parent_identifier)
        }

        #[unsafe(method_id(filename))]
        fn item_filename(&self) -> Retained<NSString> {
            NSString::from_str(&self.ivars().filename)
        }

        #[unsafe(method_id(typeIdentifier))]
        fn type_identifier(&self) -> Retained<NSString> {
            let type_id = if self.ivars().is_dir {
                FOLDER_TYPE_ID
            } else {
                FILE_TYPE_ID
            };
            NSString::from_str(type_id)
        }

        #[unsafe(method_id(documentSize))]
        fn document_size(&self) -> Option<Retained<NSNumber>> {
            if self.ivars().is_dir {
                None
            } else {
                Some(NSNumber::new_i64(self.ivars().size))
            }
        }

        #[unsafe(method(contentModificationDate))]
        fn content_modification_date(&self) -> *mut AnyObject {
            let ts = self.ivars().mod_time.unwrap_or(0) as f64;
            unsafe { msg_send![class!(NSDate), dateWithTimeIntervalSince1970: ts] }
        }

        #[unsafe(method(capabilities))]
        fn capabilities(&self) -> u64 {
            if self.ivars().is_dir {
                0b1111
            } else {
                0b111111
            }
        }
    }
);

impl RustFileProviderItem {
    /// Allocate and initialise a `RustFileProviderItem` with the given metadata.
    pub fn new(data: FileProviderItemData) -> Retained<Self> {
        // set_ivars before calling super init so the methods see correct data.
        let this = Self::alloc().set_ivars(ItemIvars {
            identifier: data.identifier,
            parent_identifier: data.parent_identifier,
            filename: data.filename,
            is_dir: data.is_dir,
            size: data.size,
            mod_time: data.mod_time,
        });
        // super(this) knows the superclass (NSObject) from the define_class! above.
        unsafe { msg_send![super(this), init] }
    }
}

// ── Identifier helpers ────────────────────────────────────────────────────────

pub fn nsstring_to_str(s: &NSString) -> &str {
    // SAFETY: NSString's UTF8String pointer is valid for the lifetime of `s`.
    unsafe {
        use std::ffi::c_char;
        let cstr: *const c_char = msg_send![s, UTF8String];
        if cstr.is_null() {
            ""
        } else {
            std::ffi::CStr::from_ptr(cstr).to_str().unwrap_or("")
        }
    }
}

pub fn path_to_identifier(path: &str) -> String {
    STANDARD.encode(path.as_bytes())
}

pub fn identifier_to_path(identifier: &str) -> Option<String> {
    let bytes = STANDARD.decode(identifier.as_bytes()).ok()?;
    String::from_utf8(bytes).ok()
}

pub fn is_root_identifier(id: &NSString) -> bool {
    nsstring_to_str(id) == ROOT_CONTAINER_ID
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_ascii() {
        let path = "myremote:/some/path/file.txt";
        assert_eq!(identifier_to_path(&path_to_identifier(path)).as_deref(), Some(path));
    }

    #[test]
    fn roundtrip_unicode() {
        let path = "remote:/über/café/résumé.pdf";
        assert_eq!(identifier_to_path(&path_to_identifier(path)).as_deref(), Some(path));
    }

    #[test]
    fn invalid_base64_returns_none() {
        assert!(identifier_to_path("!!!not-base64!!!").is_none());
    }

    #[test]
    fn invalid_utf8_returns_none() {
        let bad = STANDARD.encode([0xFF_u8, 0xFE, 0xFD]);
        assert!(identifier_to_path(&bad).is_none());
    }
}
