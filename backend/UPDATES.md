# Application updates

The shared `core::services::updates` service owns release discovery, update state,
and installation policy. Desktop IPC and HTTP expose the same commands and events.
Installing a downloaded update requires an explicit apply request; ordinary exit
does not apply an application update.
The cancel command also discards a downloaded update before installation starts,
returning it to the available state so another channel can be selected. Verified
disk cache entries remain available for a later retry.

## Installation ownership

| Installation                                                           | Installer                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Native desktop (Windows, macOS)                                        | Tauri updater                                             |
| Linux AppImage in an owned, writable location                          | Core signed-artifact installer                            |
| Linux DEB or RPM owned by dpkg or rpm                                  | Tauri updater (password prompt via pkexec/zenity/kdialog) |
| Portable executable / standalone server in an owned, writable location | Core signed-artifact installer                            |
| Server package owned by dpkg, rpm or pacman; server setup or MSI       | Core signed-package installer (pkexec, setup or msiexec)  |
| Direct Android APK                                                     | Core verification followed by Android's system installer  |
| Desktop AUR/pacman                                                     | Release checks and the AUR helper command                 |
| Flatpak, Docker                                                        | Release checks and the update command only                |
| Unknown, read-only, or administratively disabled installation          | Installation disabled with an explanation                 |

`get_update_policy` returns the installation kind, installer method, eligibility,
localized reason, and for external installations the command that updates them
(and the AUR package name).
For an installation the app updates itself, an update is announced only after a
compatible artifact is found for the current installation and architecture: valid
updater metadata and its referenced release asset. Missing targets produce no
update; network or metadata validation failures report a check error without
announcing an update. Read-only or administratively disabled installations still
check artifact availability, while installation remains disabled.

External installations (Docker, Flatpak, the desktop AUR packages, and DEB/RPM
installations the app cannot install itself) announce the newest release of their channel and leave the
installation to their own package source, which may publish it later. The UI shows
`paru -S <package>` or `yay -S <package>` for an AUR package when one of those
helpers is installed, and the `makepkg` steps otherwise.

Linux detection checks ownership of the running executable using the available
package managers: `pacman -Qqo` always, and `dpkg-query -S` or `rpm -qf` for a
DEB or RPM build. A query that does not answer within two seconds is asked again
on the next check. A Tauri build
reports the package format the bundler patched into it. DEB and RPM builds are
installed by Tauri only when dpkg or rpm owns the executable: the AUR packages
repackage the upstream DEB, so their binary says DEB while pacman owns it, and
they stay external. A server that pacman owns, from the release's Arch package or
the AUR package that repackages it, is updated with the Arch package. The host identifies portable/server/native execution
separately from Cargo feature unification. Permissions are checked again before
download and apply.

`RCLONE_MANAGER_INSTALLATION_TYPE=docker|container|flatpak|aur|pacman|deb|rpm`
declares external ownership. Docker and Podman containers are recognized without it
(`/.dockerenv`, `/run/.containerenv`); on other container runtimes set `container`. `RCLONE_MANAGER_DISABLE_UPDATES=1` (or `true`)
disables in-app installation while preserving release checks. Neither setting
grants privileges.

## Signed artifacts and release workflows

Portable, server, and APK release workflows run
`scripts/create-update-manifest.cjs`. They publish a shared signed catalog
(`updater.json`) and versioned ZIPs or APKs. Signatures are embedded
in the catalog rather than published as sidecars. See
[release update manifests](../scripts/UPDATER.md) for the schema and packaging.

Kinds are `portable`, `server`, and `android`. Architecture names are `x86_64`,
`aarch64`, `armv7`, and `i686`. OS names match Rust (`linux`, `windows`, `macos`,
`android`). Server files belong to `headless-v...` releases; portable and APK
files belong to `v...` releases. The native Tauri `latest.json` remains separate.

The signed manifest binds version, product, target, asset name, byte size,
SHA-256, and artifact signature. The installer verifies both signatures using
the pinned production public key and rejects mismatched or non-increasing
versions. `scripts/create-update-manifest.cjs` checks file names and formats
before signing; the app does not check them again, and it ignores catalog and
manifest fields it does not know, so a field added later never blocks an update
of an installed version. Downloads use HTTPS, bounded redirects and size limits. Requests fail
when a connection stalls (30 s to connect, 120 s without data) but have no total
deadline, so large downloads finish on slow links; the native Tauri check and
download use the same limits. Release lists are revalidated with their ETag.
Previously verified cached downloads are reverified before reuse.

Production workflows require `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Android additionally requires its existing,
persistent release keystore secrets. A missing Android release key fails the
build rather than generating a key incompatible with earlier installations.
Direct installers do not announce releases without `updater.json`.

The public fixtures under `core/src/services/updates/fixtures/` test signatures
without network access or production secrets. Their public key is never trusted
by production installation code.

## Prerelease versions

Keep the Cargo workspace, Tauri configuration and package version
in sync, for example `0.3.3`. All five release workflows use
`scripts/release-version.cjs` to set the GitHub prerelease flag from the version.
Releases remain drafts until explicitly published. The stable update channel
excludes prereleases; the beta channel includes prereleases and stable versions.

A pre-release build can move to the latest stable release even when that release has
a lower version number, so choosing the stable channel never waits for the next stable
version. This applies to installers that replace the running build (Tauri for native,
AppImage, portable and server); packages only move forward, including DEB and RPM
installed by Tauri (`rpm -U` refuses downgrades) and the server's Arch package
(`pacman -U` would downgrade), and Android version codes cannot decrease. A stable build is only offered newer versions. The Rclone engine already
follows Rclone's own `selfupdate`, which installs the latest release of the selected
channel whenever it differs from the installed one.

Android builds through `npm run tauri android build` or `android dev` derive a
reproducible versionCode, including local builds and every CI architecture. The
wrapper supplies Tauri's Android versionCode override, with automatic increments
disabled. Rebuilding the same version produces the same code; a new APK update
requires a new version. Direct Gradle builds reuse the last Tauri-generated
properties, so run the Tauri wrapper first after changing the version.

The code is `((major * 100 + minor) * 100 + patch) * 1000 + suffix`. Minor and
patch are limited to 0–99. Prerelease labels are ordered `alpha`, `beta`, `dev`,
`preview`, `rc`, matching SemVer's lexical ordering. Each label has a block of
200 codes; a bare label uses its block's first code and `.0` through `.197` use
the following codes. Stable uses suffix 999. Unsupported Android labels,
iterations or codes outside Android's 1–2,100,000,000 range fail before building.
Other targets can still use other valid prerelease labels.

For example, `0.3.4-beta.1` produces 304202, `0.3.4-beta.2` produces 304203 and
`0.3.4` produces 304999. This also exceeds the legacy code 3003 for `0.3.3`.
Do not change the numbering formula after publishing APKs without checking
compatibility with previously installed versionCodes.

## Replacement and restart

Portable, server ZIP and AppImage builds replace themselves in place, as
`rclone selfupdate` does. The verified file is written beside the installed one
(on the same filesystem, with its permissions) and renamed over it; an AppImage
replaces the image named by `$APPIMAGE`. Windows cannot replace a running
executable but can rename it: the running file is kept as `<name>.old.exe` and
removed on the next start. macOS portable builds replace the complete `.app`
bundle, whose signature covers every file in it. The executable must belong to the
effective user and its folder must be writable. User configuration next to the
executable is never touched.

The application then restarts the way it always does. The server on Unix
replaces itself with `exec` of the same path, so systemd, containers and
terminals keep tracking the same PID; on Windows it starts the new file once its
listener has closed. The desktop app uses Tauri's restart, which starts the path
it was launched from (the AppImage for an AppImage). The running process keeps
its own copy of the old file until then. There is no helper process, no startup
trial and no rollback: if a release does not start, install the previous one by
hand.

Versions before 0.3.7-beta.3 install an update through a supervisor that puts the
old version back unless the new one writes a `ready.json` receipt within 90
seconds, into the directory named by `RCMAN_UPDATE_HEALTH_DIRECTORY` with the
token in `RCMAN_UPDATE_HEALTH_TOKEN`. The current build writes that receipt as the
first thing it does (`binary::on_startup`) and removes those variables, so an
update from such a version is kept. That supervisor stays in place as the
parent until the application exits.

Apply failures returned by an installer preserve the downloaded payload for a
retry and publish a localized failure in the shared snapshot; a later check keeps
it until another release is found. A failed restart after an update exits, so the
installed build starts next. `get_app_update_info` and
`get_rclone_update_info` return the whole updater state, so a reloaded web UI or
another window shows the same picture: whether a check (including a scheduled
one) is running, when the last check finished and why it failed, and the reminder
to restart a remote rclone after it updated itself. Installing state
prevents concurrent apply requests. The UI starts with installation disabled
until backend policy resolves.

Android verifies the APK package name, increasing version code, and current
signing certificate set before requesting system installation. The verified download
cache is the APK handed to the installer; no second copy is written. Unknown-source
approval is handled by Android settings; a denied request retains the verified
download for retry. Android completion or cancellation remains controlled by the
system installer. This is for direct APK distribution; Play in-app updates are
not implemented here.

## Operational limits

The custom installer does not collect root/admin passwords or provision a
privileged maintenance service. Protected portable/server paths remain blocked;
administrators must use deployment tooling or arrange an owned, writable
installation. Tauri's native installers retain their platform authorization flows.
DEB, RPM and Arch package updates need a session that can show the password prompt: Tauri's
(pkexec, zenity or kdialog) for the desktop app; for the server pkexec's polkit
agent or, where no agent runs, `sudo -A` with a zenity or kdialog dialog. A
headless service without one reports the failure and keeps the
verified download for a retry.

No update is rolled back: a release that does not start is replaced by hand
with the previous one. TUF metadata expiry/key rotation and staged rollouts are
not implemented.

Real Windows/macOS installation, protected-directory behavior, and Android
installer dialogs require platform testing before release. CI runs the shared
updater unit tests on Linux, Windows, and macOS; the Android release workflow also
runs the APK identity validator tests.
The replacement tests use a disposable public fixture key; production always
uses the pinned production key.
