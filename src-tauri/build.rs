fn main() {
    // Link librclone static archive when the `librclone` feature is enabled.
    //
    // We link it statically (whole-archive) so the rclone symbols are available
    // to the FFI module. cgo also needs libc and pthread on Unix; those are
    // linked automatically by Rust's std.
    #[cfg(feature = "librclone")]
    {
        let target = std::env::var("TARGET").unwrap_or_else(|_| {
            panic!("TARGET env var not set — build.rs must be invoked by cargo");
        });
        let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        let lib_ext = if target_os == "android" { "so" } else { "a" };

        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let target_lib_path = format!("{manifest_dir}/librclone/{target}/librclone.{lib_ext}");
        let rclone_src_dir = std::env::var("RCLONE_SRC_DIR")
            .unwrap_or_else(|_| format!("{manifest_dir}/../../rclone"));

        let rebuild_needed = check_rebuild_needed(&rclone_src_dir, &target_lib_path);

        if rebuild_needed {
            let build_res = build_librclone(&target, &target_lib_path);
            if let Err(e) = build_res {
                let msg = format!("Failed to build librclone: {e}");
                if std::env::var("LIBRCLONE_SKIP_LINK_CHECK").is_ok() {
                    println!("cargo:warning={msg}");
                } else {
                    panic!("{msg}");
                }
            }
        }

        // Try several layouts for the librclone archive:
        //   1. src-tauri/librclone/<triple>/librclone.<ext>  (per-target)
        //   2. src-tauri/librclone/librclone.<ext>            (single, multi-arch — not recommended)
        let candidates = [
            target_lib_path,
            format!("{manifest_dir}/librclone/librclone.{lib_ext}"),
        ];

        let lib_path = candidates.iter().find(|p| std::path::Path::new(p).exists());

        let lib_path = match lib_path {
            Some(p) => p.clone(),
            None => {
                let msg = format!(
                    "librclone archive not found for target {target}.\n\
                     Looked in:\n  {}\n\
                     Or see docs/librclone.md for manual build instructions.",
                    candidates.join("\n  ")
                );
                if std::env::var("LIBRCLONE_SKIP_LINK_CHECK").is_ok() {
                    println!("cargo:warning={msg}");
                } else {
                    panic!("{msg}");
                }
                // If skip-check is set, continue without linking (will fail at runtime).
                String::new()
            }
        };

        if !lib_path.is_empty() {
            let lib_dir = std::path::Path::new(&lib_path)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();

            let link_type = if target_os == "android" {
                "dylib"
            } else {
                "static"
            };
            println!("cargo:rustc-link-lib={link_type}=rclone");
            println!("cargo:rustc-link-search=native={lib_dir}");

            // cgo-produced archives need libc and pthread on Unix, and
            // some extra Windows libs on Windows. Rust's std links libc
            // automatically, but pthread needs to be explicit on some platforms.
            if target_os == "android" {
                println!("cargo:rustc-link-lib=dylib=log");
                println!("cargo:rustc-link-lib=dylib=dl");

                // Copy the librclone.so library to jniLibs for the Android packaging
                let abi = match target.as_str() {
                    "aarch64-linux-android" => Some("arm64-v8a"),
                    "armv7-linux-androideabi" | "thumbv7neon-linux-androideabi" => {
                        Some("armeabi-v7a")
                    }
                    "x86_64-linux-android" => Some("x86_64"),
                    "i686-linux-android" => Some("x86"),
                    _ => None,
                };
                if let Some(abi_name) = abi {
                    let jni_dir =
                        format!("{manifest_dir}/gen/android/app/src/main/jniLibs/{abi_name}");
                    if let Err(e) = std::fs::create_dir_all(&jni_dir) {
                        println!("cargo:warning=Failed to create jniLibs directory {jni_dir}: {e}");
                    } else {
                        let dest_path = format!("{jni_dir}/librclone.so");
                        if let Err(e) = std::fs::copy(&lib_path, &dest_path) {
                            println!(
                                "cargo:warning=Failed to copy librclone.so to {dest_path}: {e}"
                            );
                        } else {
                            println!("cargo:warning=Copied librclone.so to {dest_path}");
                        }
                    }
                }
            } else if target_os == "ios" {
                // iOS: no extra libs needed — libc and pthread are in the SDK.
            } else if target_os == "windows" {
                println!("cargo:rustc-link-lib=dylib=ws2_32");
                println!("cargo:rustc-link-lib=dylib=advapi32");
            } else {
                // Unix systems (Linux, macOS, etc.)
                println!("cargo:rustc-link-lib=dylib=pthread");
            }
        }

        // Re-run if the archive changes or if Go files in rclone change.
        println!("cargo:rerun-if-changed=librclone/");
        println!("cargo:rerun-if-changed={}/librclone/", rclone_src_dir);
    }

    tauri_build::build();
}

#[cfg(feature = "librclone")]
fn check_rebuild_needed(rclone_src_dir: &str, lib_a_path: &str) -> bool {
    let lib_metadata = match std::fs::metadata(lib_a_path) {
        Ok(m) => m,
        Err(_) => return true, // lib doesn't exist, need rebuild
    };
    let lib_mtime = match lib_metadata.modified() {
        Ok(t) => t,
        Err(_) => return true,
    };

    let go_dir = std::path::Path::new(rclone_src_dir).join("librclone");
    if !go_dir.exists() {
        return false; // source directory not found, can't rebuild
    }

    check_rebuild_needed_dir(&go_dir, lib_mtime)
}

#[cfg(feature = "librclone")]
fn check_rebuild_needed_dir(dir: &std::path::Path, lib_mtime: std::time::SystemTime) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Ignore ctest, php, python directories to avoid unnecessary mtime checks
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default();
                if name == "ctest" || name == "php" || name == "python" {
                    continue;
                }
                if check_rebuild_needed_dir(&path, lib_mtime) {
                    return true;
                }
            } else if path.extension().is_some_and(|ext| ext == "go")
                && let Ok(mtime) = std::fs::metadata(&path).and_then(|m| m.modified())
                && mtime > lib_mtime
            {
                println!(
                    "cargo:warning=Source file {} is newer than archive",
                    path.display()
                );
                return true;
            }
        }
    }
    false
}

#[cfg(feature = "librclone")]
fn build_librclone(target: &str, out_a_path: &str) -> Result<(), String> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let rclone_src_dir =
        std::env::var("RCLONE_SRC_DIR").unwrap_or_else(|_| format!("{manifest_dir}/../../rclone"));

    let rclone_src_path = std::path::Path::new(&rclone_src_dir);
    if !rclone_src_path.exists() {
        return Err(format!(
            "rclone source directory not found at: {}. Please set RCLONE_SRC_DIR.",
            rclone_src_path.display()
        ));
    }

    // Create target directory if it doesn't exist
    let out_path = std::path::Path::new(out_a_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }

    // Determine GOOS and GOARCH
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    let goos = match target_os.as_str() {
        "android" => "android",
        "ios" => "ios",
        "linux" => "linux",
        "macos" | "darwin" => "darwin",
        "windows" => "windows",
        other => other,
    };

    let goarch = match target_arch.as_str() {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "arm" => "arm",
        "x86" => "386",
        other => other,
    };

    // Discover and stage Go patch files from src-tauri/librclone_patches
    struct PatchCleaner {
        paths: Vec<std::path::PathBuf>,
    }
    impl Drop for PatchCleaner {
        fn drop(&mut self) {
            for path in &self.paths {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    let patches_dir = std::path::Path::new(&manifest_dir).join("librclone_patches");
    println!("cargo:rerun-if-changed={}", patches_dir.display());

    let librclone_dir = rclone_src_path.join("librclone");
    let mut staged_cleaner = PatchCleaner { paths: Vec::new() };
    let mut go_build_args = vec!["./librclone/librclone.go".to_string()];

    if patches_dir.exists()
        && let Ok(entries) = std::fs::read_dir(&patches_dir)
    {
        let mut patch_entries: Vec<_> = entries.flatten().collect();
        patch_entries.sort_by_key(|e| e.file_name());

        for entry in patch_entries {
            let path = entry.path();
            if path.is_file() {
                let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                if file_name.ends_with(".go") && !file_name.ends_with("_test.go") {
                    let staged_name = format!("patch_{file_name}");
                    let dest_path = librclone_dir.join(&staged_name);
                    if let Err(e) = std::fs::copy(&path, &dest_path) {
                        return Err(format!(
                            "Failed to copy patch file {} to {}: {e}",
                            path.display(),
                            dest_path.display()
                        ));
                    }
                    staged_cleaner.paths.push(dest_path);
                    go_build_args.push(format!("./librclone/{staged_name}"));
                }
            }
        }
    }

    // Apply .patch files to rclone source (reversed after build via PatchReverser)
    struct PatchReverser {
        rclone_dir: std::path::PathBuf,
        patches: Vec<std::path::PathBuf>,
    }
    impl Drop for PatchReverser {
        fn drop(&mut self) {
            for patch in &self.patches {
                let _ = std::process::Command::new("git")
                    .args(["apply", "--reverse"])
                    .arg(patch)
                    .current_dir(&self.rclone_dir)
                    .output();
            }
        }
    }
    let mut patch_reverser = PatchReverser {
        rclone_dir: rclone_src_path.to_path_buf(),
        patches: Vec::new(),
    };

    if patches_dir.exists()
        && let Ok(entries) = std::fs::read_dir(&patches_dir)
    {
        let mut patch_entries: Vec<_> = entries.flatten().collect();
        patch_entries.sort_by_key(|e| e.file_name());

        for entry in patch_entries {
            let path = entry.path();
            if path.is_file() {
                let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                if file_name.ends_with(".patch") {
                    // Check if already applied
                    let check = std::process::Command::new("git")
                        .args(["apply", "--check", "--reverse"])
                        .arg(&path)
                        .current_dir(rclone_src_path)
                        .output();
                    let already_applied = check.map(|o| o.status.success()).unwrap_or(false);

                    if !already_applied {
                        let apply = std::process::Command::new("git")
                            .args(["apply"])
                            .arg(&path)
                            .current_dir(rclone_src_path)
                            .output();
                        match apply {
                            Ok(output) if output.status.success() => {
                                println!("cargo:warning=Applied rclone patch: {file_name}");
                                patch_reverser.patches.push(path.clone());
                            }
                            Ok(output) => {
                                let stderr = String::from_utf8_lossy(&output.stderr);
                                return Err(format!(
                                    "Failed to apply rclone patch {file_name}: {stderr}"
                                ));
                            }
                            Err(e) => {
                                return Err(format!(
                                    "Failed to run git apply for {file_name}: {e}"
                                ));
                            }
                        }
                    } else {
                        println!("cargo:warning=Rclone patch already applied: {file_name}");
                    }
                }
            }
        }
    }

    // Prepare go build command
    let mut cmd = std::process::Command::new("go");
    cmd.current_dir(rclone_src_path);
    let buildmode = if target_os == "android" {
        "-buildmode=c-shared"
    } else {
        "-buildmode=c-archive"
    };
    cmd.arg("build").arg(buildmode);

    if target_os != "android" && target_os != "ios" {
        cmd.arg("-tags").arg("cmount");
    }

    cmd.arg("-o").arg(out_a_path);
    for arg in &go_build_args {
        cmd.arg(arg);
    }

    // Environment variables
    cmd.env("GOOS", goos);
    cmd.env("GOARCH", goarch);
    cmd.env("CGO_ENABLED", "1");

    // Setup cross-compiler (CC) if cross-compiling
    let host = std::env::var("HOST").unwrap_or_default();
    if target != host {
        let target_cc_var = format!("CC_{}", target.replace('-', "_"));
        if let Ok(cc) = std::env::var(&target_cc_var).or_else(|_| std::env::var("CC")) {
            cmd.env("CC", cc);
        } else if goos == "android" {
            // Android NDK fallback
            if let Some(ndk) = locate_ndk() {
                let host_os = if cfg!(target_os = "windows") {
                    "windows-x86_64"
                } else if cfg!(target_os = "macos") {
                    "darwin-x86_64"
                } else {
                    "linux-x86_64"
                };
                let clang_suffix = if cfg!(target_os = "windows") {
                    ".cmd"
                } else {
                    ""
                };
                let arch_prefix = match goarch {
                    "arm64" => "aarch64-linux-android24",
                    "arm" => "armv7a-linux-androideabi24",
                    "amd64" => "x86_64-linux-android24",
                    "386" => "i686-linux-android24",
                    _ => "",
                };
                if !arch_prefix.is_empty() {
                    let cc_path = format!(
                        "{ndk}/toolchains/llvm/prebuilt/{host_os}/bin/{arch_prefix}-clang{clang_suffix}"
                    );
                    if std::path::Path::new(&cc_path).exists() {
                        cmd.env("CC", cc_path);
                    }
                }
            }
        }
    }

    if goos == "android" {
        cmd.env("CGO_LDFLAGS", "-lm -llog -ldl");
    }

    println!("cargo:warning=Running go build for librclone (GOOS={goos} GOARCH={goarch})...");
    let status = cmd.status();

    // Clean up temporary patch files (staged_cleaner handles drop automatically)
    drop(staged_cleaner);

    match status {
        Ok(stat) if stat.success() => {
            println!("cargo:warning=librclone.a built successfully.");
            Ok(())
        }
        Ok(stat) => Err(format!("go build failed with exit status: {:?}", stat)),
        Err(e) => Err(format!("Failed to execute go build: {e}")),
    }
}

#[cfg(feature = "librclone")]
fn locate_ndk() -> Option<String> {
    if let Some(ndk) = std::env::var("ANDROID_NDK_HOME")
        .ok()
        .filter(|n| !n.is_empty())
    {
        return Some(ndk);
    }
    if let Some(ndk) = std::env::var("NDK_HOME").ok().filter(|n| !n.is_empty()) {
        return Some(ndk);
    }
    let sdk_dir = if let Ok(sdk) = std::env::var("ANDROID_HOME") {
        std::path::PathBuf::from(sdk)
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        std::path::PathBuf::from(home).join("Android/Sdk")
    };

    let ndk_dir = sdk_dir.join("ndk");
    if let Ok(entries) = std::fs::read_dir(ndk_dir) {
        let mut versions: Vec<_> = entries.flatten().filter(|e| e.path().is_dir()).collect();
        versions.sort_by_key(|e| e.file_name());
        if let Some(latest) = versions.last() {
            return Some(latest.path().to_string_lossy().into_owned());
        }
    }
    None
}
