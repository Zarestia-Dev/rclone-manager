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

# Application updater

- [ ] Stream update downloads to disk. `download.rs` buffers the whole package in
  memory (up to `MAX_ARTIFACT_SIZE`), and extraction, the staged payload and the
  apply step each hold another copy. Hash and verify while streaming and pass file
  paths through `AppUpdate` instead of `Vec<u8>`.
- [ ] Clean the update cache after a committed update. `app-updates/*.payload` and the
  Android `update.apk` are only overwritten by the next update, never removed.
- [ ] Back up the configuration before the first launch of a new version. Rollback
  restores only the executable, so a version that migrates settings and then fails
  to start can leave data an older build cannot read.
- [ ] Split `UpdaterError` and the shared state types between the application and the
  Rclone engine updaters, and move `updater_running` out of `RcloneState`.
- [ ] Give `update_found` and `download_progress` typed constants and payloads in
  `utils/types/events.rs` instead of ad-hoc `APP_EVENT` JSON.
- [ ] Consider dropping the consecutive-update handoff (`next.json`) from the
  supervisor: it carries much of its complexity for a rare case.

# Android media range workaround

- [x] Removed the media range backport (`MediaRangeResponse.kt`, its unit tests and
  the Gradle hook): the locked Wry 0.57.1 ships the upstream fix
  ([wry#1865](https://github.com/tauri-apps/wry/pull/1865)) in `RustWebViewClient.kt`.
- [x] Verified local/remote audio and video playback and seeking on Android
  after the removal (2026-10-25).
