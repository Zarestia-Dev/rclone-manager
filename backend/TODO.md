# Server platform support

The independent `release-server.yml` workflow builds `rclone-manager-server` archives for Linux,
Windows, and macOS on x86_64 and aarch64. Native tray packages keep the
`rclone-manager-headless` name. Confirm the six server builds and their runtime
dependencies on CI before publishing the draft release.

Only add targets supported by both Rclone and this application's dependencies.
Rclone's `bin/cross-compile.go` (`osarches` and `archFlags`) is the reference for
upstream release targets; a Rust target alone is not evidence of application support.

- [ ] Add Linux ARMv7 and x86 first, after correcting Rclone download mappings in
  `core/src/rclone/binaries/util.rs`. Rust reports `x86`, not `i686`; ARM needs an
  explicit version/ABI mapping to Rclone's `arm-v7` archive name.
- [ ] Evaluate Windows x86 and Linux ARMv5/ARMv6, MIPS/MIPSLE from Rclone's matrix.
  Check Rust target availability, TLS dependencies, C toolchains, minimum OS/libc,
  and native credential storage before adding a build job.
- [ ] Evaluate FreeBSD, NetBSD, OpenBSD, Solaris, AIX, and Plan 9 individually.
  `core/src/rclone/binaries/provision.rs` currently accepts Linux/macOS/Windows only;
  `netstat2` and other platform integrations also limit support. Replace or gate
  unsupported integrations and document unavailable features before advertising
  these platforms. Some may remain unsupported by Rust or required dependencies.
- [ ] For every added target, verify build/linking, Rclone provisioning and
  startup, HTTP/SSE, transfers, credential storage, signals/service shutdown,
  and mounting where supported on a real machine or suitable VM.
- [ ] Extend archive naming, website download parsing, and installation docs
  together when a target is ready. Keep unsupported targets out of the download
  list; document exact runtime requirements for each released archive.

Android stays in the mobile release workflow. WebAssembly is not a standalone
server target and is disabled in the inspected Rclone release matrix.

# Android media range workaround

- [ ] Once a compatible published Tauri/Wry release includes
  [wry#1865](https://github.com/tauri-apps/wry/pull/1865), update the dependencies
  and lockfile, then remove the media range backport from
  `desktop/gen/android/app/build.gradle.kts`,
  `desktop/gen/android/app/src/main/java/com/rclone/manager/MediaRangeResponse.kt`,
  and its `MediaRangeResponseTest.kt` unit tests. Confirm the resolved Wry source
  contains the upstream fix before removing the workaround. Rebuild the Android
  app and verify local/remote audio and video playback and seeking, including
  offsets beyond 2 GiB. The user confirmed the current workaround works on
  2026-10-14; the latest published Wry on that date (0.57.0) does not include the fix.
