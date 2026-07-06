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

        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let target_lib_path = format!("{manifest_dir}/librclone/{target}/librclone.a");
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
        //   1. src-tauri/librclone/<triple>/librclone.a  (per-target)
        //   2. src-tauri/librclone/librclone.a            (single, multi-arch — not recommended)
        let candidates = [
            target_lib_path,
            format!("{manifest_dir}/librclone/librclone.a"),
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

            println!("cargo:rustc-link-lib=static=rclone");
            println!("cargo:rustc-link-search=native={lib_dir}");

            // cgo-produced archives need libc and pthread on Unix, and
            // some extra Windows libs on Windows. Rust's std links libc
            // automatically, but pthread needs to be explicit on some platforms.
            #[cfg(target_os = "android")]
            {
                println!("cargo:rustc-link-lib=dylib=log");
                println!("cargo:rustc-link-lib=dylib=dl");
            }
            #[cfg(target_os = "ios")]
            {
                // iOS: no extra libs needed — libc and pthread are in the SDK.
            }
            #[cfg(all(unix, not(target_os = "android"), not(target_os = "ios")))]
            {
                println!("cargo:rustc-link-lib=dylib=pthread");
            }
            #[cfg(target_os = "windows")]
            {
                println!("cargo:rustc-link-lib=dylib=ws2_32");
                println!("cargo:rustc-link-lib=dylib=advapi32");
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

    // Create temporary imports.go inside rclone/librclone
    let librclone_dir = rclone_src_path.join("librclone");
    let temp_imports = librclone_dir.join("imports.go");

    let imports_content = r##"package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"bufio"
	"context"
	"io"
	"os"
	"strings"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/rc"
	_ "github.com/rclone/rclone/cmd/all"
)

//export RcloneSyncEnv
func RcloneSyncEnv(key *C.char) {
	goKey := C.GoString(key)
	cVal := C.getenv(key)
	if cVal != nil {
		os.Setenv(goKey, C.GoString(cVal))
	}
}

func rcIsConfigEncrypted(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	path := config.GetConfigPath()
	if path == "" {
		return rc.Params{"encrypted": false}, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return rc.Params{"encrypted": false}, nil
		}
		return nil, err
	}
	defer f.Close()

	reader := bufio.NewReader(f)
	for {
		line, _, err := reader.ReadLine()
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		l := strings.TrimSpace(string(line))
		if len(l) == 0 || strings.HasPrefix(l, ";") || strings.HasPrefix(l, "#") {
			continue
		}
		if l == "RCLONE_ENCRYPT_V0:" {
			return rc.Params{"encrypted": true}, nil
		}
		break
	}
	return rc.Params{"encrypted": false}, nil
}

func init() {
	// Disable interactive prompts and password asking globally for in-process librclone FFI
	fs.GetConfig(context.Background()).AskPassword = false
	fs.GetConfig(context.Background()).AutoConfirm = true

	rc.Add(rc.Call{
		Path:  "config/isencrypted",
		Fn:    rcIsConfigEncrypted,
		Title: "Check if the config file is encrypted on disk.",
		Help: `
Returns a JSON object:
- encrypted: true/false
`,
	})
}
"##;

    std::fs::write(&temp_imports, imports_content)
        .map_err(|e| format!("Failed to write temporary imports.go: {e}"))?;

    // Prepare go build command
    let mut cmd = std::process::Command::new("go");
    cmd.current_dir(rclone_src_path);
    cmd.arg("build")
        .arg("-buildmode=c-archive")
        .arg("-tags")
        .arg("cmount")
        .arg("-o")
        .arg(out_a_path)
        .arg("./librclone/librclone.go")
        .arg("./librclone/imports.go");

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
            if let Ok(ndk) = std::env::var("ANDROID_NDK_HOME") {
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

    // Clean up temporary file
    let _ = std::fs::remove_file(&temp_imports);

    match status {
        Ok(stat) if stat.success() => {
            println!("cargo:warning=librclone.a built successfully.");
            Ok(())
        }
        Ok(stat) => Err(format!("go build failed with exit status: {:?}", stat)),
        Err(e) => Err(format!("Failed to execute go build: {e}")),
    }
}
