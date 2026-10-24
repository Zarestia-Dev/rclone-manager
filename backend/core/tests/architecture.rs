//! Guard crate boundaries regardless of which runtime is compiled.
use std::path::Path;

fn references_dependency(source: &str, dependency: &str) -> bool {
    source
        .lines()
        .any(|line| !line.trim_start().starts_with("//") && line.contains(dependency))
}

fn assert_no_dependencies(directory: &Path, forbidden: &[&str]) {
    assert!(
        directory.is_dir(),
        "Missing source directory: {}",
        directory.display()
    );
    for entry in walkdir::WalkDir::new(directory) {
        let entry = entry.unwrap();
        if entry.path().extension().is_some_and(|ext| ext == "rs") {
            let source = std::fs::read_to_string(entry.path()).unwrap();
            for dependency in forbidden {
                assert!(
                    !references_dependency(&source, dependency),
                    "{} must not depend on {dependency}",
                    entry.path().display()
                );
            }
        }
    }
}
#[test]
fn dependency_guard_ignores_comment_lines_but_checks_code() {
    assert!(!references_dependency(
        "//! No tauri:: dependency.\n  /// Replaces tauri_plugin_shell.\n// tauri::AppHandle",
        "tauri::",
    ));
    assert!(references_dependency("use tauri::AppHandle;", "tauri::"));
    assert!(references_dependency(
        "use tauri_plugin_shell::ShellExt;",
        "tauri_plugin_"
    ));
}
#[test]
fn core_has_no_transport_or_host_dependencies() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert_no_dependencies(
        &root.join("src"),
        &[
            "tauri::",
            "tauri_plugin_",
            "axum::",
            "crate::native::",
            "crate::desktop::",
            "../desktop/",
            "../server/",
            "feature = \"web-server\"",
        ],
    );
}
#[test]
fn server_has_no_native_dependencies() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert_no_dependencies(
        &root.join("../server/src"),
        &[
            "tauri::",
            "tauri_plugin_",
            "crate::native::",
            "crate::desktop::",
        ],
    );
}
#[test]
fn native_adapters_have_no_http_dependencies() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for directory in ["../desktop/src/native", "../desktop/src/desktop"] {
        assert_no_dependencies(&root.join(directory), &["axum::", "crate::web::"]);
    }
}
