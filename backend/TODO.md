# After 0.3.7: from Headless to Server

0.3.7 is the release that moves RClone Manager Headless (0.3.6 and older) to
RClone Manager Server. Once it is published, the transition scaffolding goes and
the server's releases get their own tag.

**Before 0.3.7 ships**

- [x] Let the server also recognise `server-v` tags (`release_prefixes` in
  `server/src/lib.rs`, matched in `core/src/services/updates/mod.rs`). Without it a
  0.3.7 server would never see a `server-v` release. The 0.3.7 release itself stays
  `headless-v`: the Headless app 0.3.6 and the 0.3.7 betas only look for that.

**After 0.3.7 is published**

- [ ] Tag the server's releases `server-v<version>` instead of `headless-v<version>`
  (`release_prefixes` in the server already lists `server-v` first), changing together: `release-server.yml` (`tag_name`, the three `RELEASE_TAG`s,
  the `--check` and publish arguments), `validateTag` in
  `scripts/publish-custom-updater.cjs`, `RELEASE_URL` in
  `scripts/create-update-manifest.cjs`, the prefix in `publish-to-aur.sh` and the
  source URLs in `PKGBUILD-server`, the website's `isHeadlessRelease`
  (`release.utils.ts`, it looks for "headless" in the tag), the tests and fixtures
  that use `headless-v`, AGENTS.md Rule 17 and the docs.
- [ ] Drop `"headless-v"` from the server's `release_prefixes` (leaves `["server-v"]`) in
  the first `server-v` release: builds after 0.3.7 only need to find `server-v`, and
  the release-notes lookup then needs no fallback. 0.3.7 itself keeps both, so it sees
  `server-v` releases.
- [ ] Keep the 0.3.7 `headless-v` release published: it is the last one the Headless
  app 0.3.6 looks for, and its `latest.json` moves those installs to the server.
  Delete the older `headless-v` releases that are no longer needed.
- [ ] Stop writing `latest.json` into server releases (`tauriUpdateJson` in
  `publish-custom-updater.cjs`, its tests, UPDATER.md and AGENTS.md Rule 17): only
  the Headless app reads it, and only from `headless-v` releases.
- [ ] Remove the 0.3.7-only Headless-named DEB and RPM copies: the `case "$VERSION"`
  block at the end of "Package and sign DEB, RPM and Arch package" in
  `release-server.yml` (it already skips every version but 0.3.7*), the skip
  rule in the website's `downloads.utils.ts` and its spec, and the AGENTS.md
  Rule 17 bullet.

**Stays after the cleanup** (installed versions or existing installs depend on it):
the data folder `com.rclone.manager.headless`, the product's `mode`,
`integration_key` and `flatpak_id`, the `/usr/bin/rclone-manager-headless[-bin]`
launcher links, the start-at-login and Send To migration (`LEGACY_NAME`), the MSI
UpgradeCode, the packages' conflicts/replaces of the Headless package, the
manifest's `asset` field (versions before `url` download by it) and the legacy
supervisor receipt in `binary.rs` (versions before 0.3.7-beta.3).

# Server platform support

`release-server.yml` builds `rclone-manager-server` archives for Linux, Windows,
and macOS on x86_64 and aarch64, and the same server as DEB, RPM, Arch, Windows
setup and MSI packages for Linux and Windows. Confirm the builds and their runtime
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

# Multi-source sync: offer separate destination folders

A sync of several sources into one destination now runs as one `union` (correct, but no
server-side copy, and a changed-only watcher syncs every source; see CHANGELOG). Often the
user did not mean to merge the sources at all and wants `Backup/A`, `Backup/B`.

- [ ] In the profile editor (`app-operation-config`), when the operation is Sync, there are
  two or more sources and one destination, show an `app-alert-banner` (info) that says the
  sources are merged into one folder, with a button "Put each source in its own folder".
  Copy and Move get the same offer: they now run one after another for the same reason.
- [ ] Decide how the profile stores it. Today a profile has `srcFs` (several) and one
  `dstFs`, and `submit_transfer_batch` pairs every source with that destination. Either a
  flag that makes the backend use `<dest>/<source folder name>`, or one destination per
  source in the config. The flag keeps old profiles and the wizard unchanged.
- [ ] Names that clash: `drive:photos` and `box:photos` both end in `photos`, and a remote
  root (`drive:`) has no folder name (use the remote name). Refuse or suffix, and show the
  resulting paths before saving.
- [ ] Say what happens to files already in the destination: a sync into `Backup/A` leaves
  what the merged sync put in `Backup` itself where it is (nothing is deleted, but it stays
  there as a second copy).
- [ ] Optional "Why?" link in the banner opening a `MatBottomSheet` with a short animation of
  the user's own source and destination names: two syncs taking each other's files for
  leftovers versus one merged view. It plays once, with a replay button, and no idle loop.
