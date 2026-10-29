pub mod connectivity;
pub mod http_transport;
pub mod manager;
pub mod routing_transport;
pub mod runtime;
pub mod transport;
pub mod types;

#[cfg(feature = "librclone")]
pub mod librclone_transport;
#[cfg(feature = "librclone")]
pub mod rclone_ffi;
#[cfg(target_os = "android")]
pub mod saf_bridge;

pub use manager::{BackendManager, CopySources};
pub use transport::{BackendError, RcloneTransport, TransportKind};

#[cfg(test)]
mod saf_bridge_keep_tests {
    const BRIDGE_RS: &str = include_str!("saf_bridge.rs");
    const BRIDGE_KT: &str = include_str!(
        "../../../../desktop/gen/android/app/src/main/java/com/rclone/manager/RcloneSafBridge.kt"
    );
    const KEEP: &str = "@androidx.annotation.Keep";

    /// Names of the Kotlin methods Rust looks up through JNI, which release shrinking would
    /// otherwise remove or rename without any build error.
    fn jni_method_names(source: &str) -> Vec<&str> {
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);
        production
            .split("jni_str!(\"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .filter(|name| !name.contains('/'))
            .collect()
    }

    #[test]
    fn finds_the_jni_methods_called_from_rust() {
        let names = jni_method_names(BRIDGE_RS);
        for expected in ["requestQuit", "isNetworkMetered", "updateMountedRemotes"] {
            assert!(
                names.contains(&expected),
                "{expected} not found in {names:?}"
            );
        }
        assert!(names.iter().all(|name| !name.contains('/')));
    }

    #[test]
    fn jni_called_methods_are_kept_from_r8() {
        for name in jni_method_names(BRIDGE_RS) {
            let declaration = format!("fun {name}(");
            let at = BRIDGE_KT
                .find(&declaration)
                .unwrap_or_else(|| panic!("RcloneSafBridge.kt has no `{declaration}`"));
            let kept = BRIDGE_KT[..at]
                .lines()
                .rev()
                .take(4)
                .any(|line| line.trim() == KEEP);
            assert!(
                kept,
                "`{name}` is called from Rust by name and needs {KEEP}"
            );
        }
    }
}
