fn main() {
    println!("cargo:rerun-if-env-changed=LIBRCLONE_SKIP_LINK_CHECK");
    #[cfg(feature = "librclone")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-z,max-page-size=16384");
        if std::env::var_os("LIBRCLONE_SKIP_LINK_CHECK").is_none() {
            package_librclone();
        }
    }
    tauri_build::build();
}

#[cfg(feature = "librclone")]
fn package_librclone() {
    use std::path::PathBuf;
    let target = std::env::var("TARGET").expect("Cargo target");
    let abi = match target.as_str() {
        "aarch64-linux-android" => "arm64-v8a",
        "armv7-linux-androideabi" | "thumbv7neon-linux-androideabi" => "armeabi-v7a",
        "x86_64-linux-android" => "x86_64",
        "i686-linux-android" => "x86",
        _ => panic!("Unsupported Android target: {target}"),
    };
    // The core crate's links metadata guarantees its build finishes before packaging.
    let library_dir = std::env::var_os("DEP_RCLONE_LIB_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")?;
            let fallback = PathBuf::from(manifest_dir)
                .join("../core/librclone")
                .join(&target);
            if fallback.join("librclone.so").exists() {
                Some(fallback)
            } else {
                None
            }
        })
        .expect("librclone build metadata");
    let source = library_dir.join("librclone.so");
    println!("cargo:rerun-if-changed={}", source.display());
    let destination = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("gen/android/app/src/main/jniLibs")
        .join(abi);
    std::fs::create_dir_all(&destination).expect("Create Android JNI directory");
    std::fs::copy(source, destination.join("librclone.so")).expect("Package librclone for Android");
}
