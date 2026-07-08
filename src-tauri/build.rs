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
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/rc"
	_ "github.com/rclone/rclone/cmd/all"
	"golang.org/x/crypto/nacl/secretbox"
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

func rcConfigEncrypt(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	password, err := in.GetString("password")
	if err != nil {
		return nil, err
	}
	err = config.SetConfigPassword(password)
	if err != nil {
		return nil, err
	}
	config.SaveConfig()
	return rc.Params{}, nil
}

func rcConfigDecrypt(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	// Config must already be unlocked in memory — prevents use on a locked config.
	if !config.IsEncrypted() {
		return nil, errors.New("config is not currently unlocked or is not encrypted")
	}
	// Require the current password as explicit confirmation before removing encryption.
	password, err := in.GetString("password")
	if err != nil {
		return nil, err
	}
	if err = config.SetConfigPassword(password); err != nil {
		return nil, err
	}
	config.ClearConfigPassword()
	config.SaveConfig()
	return rc.Params{}, nil
}

// rcValidateConfigPassword validates a password against the encrypted config file
// by performing a real try-decrypt with secretbox. This avoids calling LoadedData()
// which would panic inside an RC job on a wrong/missing password.
// It does NOT modify the in-memory config state — it only reads the file.
func rcValidateConfigPassword(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	password, err := in.GetString("password")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(password) == "" {
		return nil, errors.New("password must not be empty")
	}

	configPath := config.GetConfigPath()
	if configPath == "" {
		return nil, errors.New("no config file path set")
	}

	f, err := os.Open(configPath)
	if err != nil {
		return nil, fmt.Errorf("cannot open config file: %w", err)
	}
	defer f.Close()

	// Scan past comments/blanks to find the encryption header.
	reader := bufio.NewReader(f)
	encryptedFound := false
	for {
		line, _, readErr := reader.ReadLine()
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return nil, fmt.Errorf("error reading config file: %w", readErr)
		}
		l := strings.TrimSpace(string(line))
		if len(l) == 0 || strings.HasPrefix(l, ";") || strings.HasPrefix(l, "#") {
			continue
		}
		if l == "RCLONE_ENCRYPT_V0:" {
			encryptedFound = true
			break
		}
		// First non-blank non-comment line is not the magic — file is not encrypted.
		return nil, errors.New("config file is not encrypted")
	}
	if !encryptedFound {
		return nil, errors.New("config file is not encrypted")
	}

	// Derive the key the same way rclone does: SHA256 of "[password][rclone-config]".
	h := sha256.New()
	h.Write([]byte("[" + password + "][rclone-config]"))
	var key [32]byte
	copy(key[:], h.Sum(nil))

	// The remaining content (after the header line) is base64-encoded ciphertext.
	dec := base64.NewDecoder(base64.StdEncoding, reader)
	box, readErr := io.ReadAll(dec)
	if readErr != nil {
		return nil, fmt.Errorf("failed to decode ciphertext: %w", readErr)
	}
	if len(box) < 24+secretbox.Overhead {
		return nil, errors.New("config ciphertext too short — file may be corrupt")
	}

	// Try to open the secretbox (nonce is first 24 bytes).
	var nonce [24]byte
	copy(nonce[:], box[:24])
	_, ok := secretbox.Open(nil, box[24:], &nonce, &key)
	if !ok {
		return nil, errors.New("wrong password: decryption failed")
	}

	// Password is correct — also set it as the active in-memory key so the
	// caller can proceed to use the config without a separate unlock call.
	if setErr := config.SetConfigPassword(password); setErr != nil {
		return nil, fmt.Errorf("password correct but failed to activate: %w", setErr)
	}

	return rc.Params{"valid": true}, nil
}

// dohQuery sends a single DNS wire-format query to the given DoH endpoint
// and returns the raw wire-format response.
func dohQuery(client *http.Client, endpoint string, query []byte) ([]byte, error) {
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(query))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DoH status: %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// dohConn implements net.Conn by tunnelling DNS queries over HTTPS (DoH).
// This bypasses Android's SELinux restriction on raw UDP/TCP port 53 sockets.
// Go's stream resolver always sends a 2-byte length prefix and expects one back.
type dohConn struct {
	buf    bytes.Buffer
	client *http.Client
}

func (c *dohConn) Write(b []byte) (int, error) {
	if len(b) < 2 {
		return 0, io.ErrShortWrite
	}
	// b[0:2] is the TCP-stream length prefix added by Go's resolver; strip it.
	query := b[2:]

	body, err := dohQuery(c.client, "https://1.1.1.1/dns-query", query)
	if err != nil {
		body, err = dohQuery(c.client, "https://8.8.8.8/dns-query", query)
		if err != nil {
			return 0, err
		}
	}

	// Re-add the 2-byte length prefix so Go's stream reader gets what it expects.
	l := len(body)
	c.buf.WriteByte(byte(l >> 8))
	c.buf.WriteByte(byte(l))
	c.buf.Write(body)
	return len(b), nil
}

func (c *dohConn) Read(b []byte) (int, error)       { return c.buf.Read(b) }
func (c *dohConn) Close() error                     { return nil }
func (c *dohConn) LocalAddr() net.Addr              { return &net.UDPAddr{} }
func (c *dohConn) RemoteAddr() net.Addr             { return &net.UDPAddr{} }
func (c *dohConn) SetDeadline(time.Time) error      { return nil }
func (c *dohConn) SetReadDeadline(time.Time) error  { return nil }
func (c *dohConn) SetWriteDeadline(time.Time) error { return nil }

func init() {
	// Disable interactive prompts and password asking globally for in-process librclone FFI
	fs.GetConfig(context.Background()).AskPassword = false
	fs.GetConfig(context.Background()).AutoConfirm = true

	if runtime.GOOS == "android" {
		httpClient := &http.Client{Timeout: 3 * time.Second}
		net.DefaultResolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				return &dohConn{client: httpClient}, nil
			},
		}
	}

	rc.Add(rc.Call{
		Path:  "config/isencrypted",
		Fn:    rcIsConfigEncrypted,
		Title: "Check if the config file is encrypted on disk.",
		Help: `
Returns a JSON object:
- encrypted: true/false
`,
	})

	rc.Add(rc.Call{
		Path:  "config/encrypt",
		Fn:    rcConfigEncrypt,
		Title: "Encrypt the config file with a password.",
		Help: `
Takes:
- password: the password to encrypt with.
`,
	})

	rc.Add(rc.Call{
		Path:  "config/decrypt",
		Fn:    rcConfigDecrypt,
		Title: "Decrypt the config file (remove password).",
		Help: `
`,
	})

	rc.Add(rc.Call{
		Path:  "config/validatepassword",
		Fn:    rcValidateConfigPassword,
		Title: "Validate a password against the encrypted config file.",
		Help: `
Validates a candidate password against the encrypted config file by performing
a real try-decrypt (secretbox.Open) — without calling LoadedData(), which would
panic inside an RC job on failure. Sets the password as the active in-memory key
on success so no separate unlock call is required.

Parameters:
- password: candidate password string

Returns:
- valid: true on success
- error on wrong password or I/O failure
`,
	})
}
"##;

    std::fs::write(&temp_imports, imports_content)
        .map_err(|e| format!("Failed to write temporary imports.go: {e}"))?;

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

    cmd.arg("-o")
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

#[cfg(feature = "librclone")]
fn locate_ndk() -> Option<String> {
    if let Ok(ndk) = std::env::var("ANDROID_NDK_HOME") {
        if !ndk.is_empty() {
            return Some(ndk);
        }
    }
    if let Ok(ndk) = std::env::var("NDK_HOME") {
        if !ndk.is_empty() {
            return Some(ndk);
        }
    }
    let sdk_dir = if let Ok(sdk) = std::env::var("ANDROID_HOME") {
        std::path::PathBuf::from(sdk)
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        std::path::PathBuf::from(home).join("Android/Sdk")
    };

    let ndk_dir = sdk_dir.join("ndk");
    if ndk_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(ndk_dir) {
            let mut versions: Vec<_> = entries.flatten().filter(|e| e.path().is_dir()).collect();
            versions.sort_by_key(|e| e.file_name());
            if let Some(latest) = versions.last() {
                return Some(latest.path().to_string_lossy().into_owned());
            }
        }
    }
    None
}
