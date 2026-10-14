//! # RClone Manager FileProvider Extension — Entry Point
//!
//! ## Lifecycle
//!
//! 1. `fileproviderd` launches this binary
//! 2. `#[ctor]` fires → ObjC classes are registered via `define_class!` (lazy, on first `class()` call)
//! 3. `main()` → `NSRunLoop::run()` (infinite)
//! 4. System looks up the principal class by name (from Info.plist) and instantiates it
//! 5. Extension methods are called as the user browses in Finder

mod bridge;
mod enumerator;
mod item;
mod provider;
mod state;

#[cfg(not(test))]
use objc2::ClassType;
use objc2_foundation::NSRunLoop;

/// Force ObjC class registration before the run loop starts.
/// `define_class!` registers lazily on first `class()` call, so we trigger it here.
#[cfg(not(test))]
#[ctor::ctor]
fn register_classes() {
    let _ = provider::RustFileProviderExtension::class();
    let _ = item::RustFileProviderItem::class();
    let _ = enumerator::RustFileProviderEnumerator::class();
    log::info!("rman-file-provider: ObjC classes registered");
}

fn main() {
    log::info!("rman-file-provider: entering run loop");
    NSRunLoop::currentRunLoop().run();
}
