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
| Native desktop / native headless with tray (Windows, macOS)            | Tauri updater                                             |
| Linux AppImage in an owned, writable location                          | Tauri updater                                             |
| Linux DEB or RPM owned by dpkg or rpm                                  | Tauri updater (password prompt via pkexec/zenity/kdialog) |
| Portable executable / standalone server in an owned, writable location | Core signed-artifact installer                            |
| Direct Android APK                                                     | Core verification followed by Android's system installer  |
| AUR/pacman                                                             | AUR availability check and the AUR helper command         |
| Flatpak, Docker                                                        | Release checks and the update command only                |
| Unknown, read-only, or administratively disabled installation          | Installation disabled with an explanation                 |

`get_update_policy` returns the installation kind, installer method, eligibility,
localized reason, and for external installations the command that updates them
(and the AUR package name).
An update is announced only after a compatible artifact is found for the current
installation and architecture. Direct installers require valid updater metadata
and its referenced release asset. Missing targets produce no update; network or
metadata validation failures report a check error without announcing an update.
Read-only or administratively disabled installations still check artifact
availability, while installation remains disabled.

External installations announce upstream availability using a matching Linux
server ZIP for Docker and a matching DEB for Flatpak (or DEB/RPM installations
the app cannot install itself). Desktop and headless products and package
architecture names are matched separately. This does not confirm that the
corresponding container image or Flathub build has already been published there.

AUR packages are published separately from GitHub releases, and only for stable
releases, so an AUR install is offered the release whose version the AUR
(`aur.archlinux.org/rpc/v5/info`) currently publishes for the owning package,
whatever the update channel. `-git` packages build the default branch and are
never announced. The UI shows `paru -S <package>` or `yay -S <package>`
when one of those helpers is installed, and the `makepkg` steps otherwise.

Linux detection checks ownership of the running executable using the available
package managers: `pacman -Qqo` always, and `dpkg-query -S` or `rpm -qf` for a
DEB or RPM build. A query that does not answer within two seconds is asked again
on the next check. A Tauri build
reports the package format the bundler patched into it. DEB and RPM builds are
installed by Tauri only when dpkg or rpm owns the executable: the AUR packages
repackage the upstream DEB, so their binary says DEB while pacman owns it, and
they stay external. The host identifies portable/server/native execution
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
versions. Downloads use HTTPS, bounded redirects and size limits. Requests fail
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

Keep the Cargo workspace, main/headless Tauri configurations and package version
in sync, for example `0.3.3`. All five release workflows use
`scripts/release-version.cjs` to set the GitHub prerelease flag from the version.
Releases remain drafts until explicitly published. The stable update channel
excludes prereleases; the beta channel includes prereleases and stable versions.

A pre-release build can move to the latest stable release even when that release has
a lower version number, so choosing the stable channel never waits for the next stable
version. This applies to installers that replace the running build (Tauri for native,
AppImage, portable and server); packages only move forward, including DEB and RPM
installed by Tauri (`rpm -U` refuses downgrades), and Android version codes cannot
decrease. A stable build is only offered newer versions. The Rclone engine already
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

The direct installer never extracts an archive over the application directory.
Windows/Linux replace the executable; macOS portable updates replace the complete
authenticated app bundle. A private `.rcman-update-*` directory on the
same filesystem holds staging files and the previous executable. Unix file
permissions are preserved; the executable must belong to the effective user.

Preparation writes the artifact and preserves the original before shutdown. It
never changes the installed executable. The launch arguments, which can include a
password, reach the helper through its private environment and are never written
to the staging directory; a handoff reuses the arguments of the running application. Unix preserves the original with a hard
link on the same filesystem; Windows makes a synced backup copy. The complete
update shutdown sequence has a 20-second deadline.

On Unix the original process uses `exec` to enter the helper, retaining the
service PID. On Windows the helper opens a handle to the original process and
acknowledges readiness before apply succeeds. It waits for that actual process to
exit, including slow cleanup, before touching the installation.

The helper verifies the signed manifest and payload, replaces the executable,
and verifies the installed file. Any installation failure, including a directory
sync failure after replacement, enters recovery before launching an application.
Rollback renames the preserved original back into place without allocating another
full binary copy. This consumes the backup. If syncing the directory after a
successful restore fails, the helper reports the durability error but still
launches the restored executable.

The installed build must provide a private receipt containing its version and a
random attempt token within 90 seconds. The update is committed as soon as the
receipt is verified; there is no further waiting period. A build that exits or
never reports before that is rolled back.
Core readiness requires successful local initialization and bootstrap, or a ready
locked-vault entry. Remote Rclone connectivity does not gate readiness. Server
readiness requires the HTTP/TLS listener to bind. A visible portable window waits
for Angular initialization (including settings/navigation) and the subsequent
render; a known locked-vault screen is also accepted. Tray-only startup does not
require a webview. This receipt is a startup check, not a continuous heartbeat.

Debug logs identify the installation policy, selected release and target,
manifest verification, payload cache use, ZIP and binary verification, and staging
paths. The update helper initializes file logging before normal application setup
and writes to the same application log directory. Its info logs record binary
replacement, startup receipt verification, `Update committed` once the receipt is
verified, and the reason for any rollback. Startup tokens are never logged.

Trial processes have an isolated Unix process group or a Windows Job Object.
Windows startup is gated until the process has been assigned to its job. A failed
trial or administrative stop cleans up its process tree before recovery. A normal
close or service stop before the receipt restores the original without reopening
it; after the receipt the update is kept. After commit,
a clean ordinary exit allows a platform-spawned restart process to survive, and on
Windows ending the waiting helper no longer ends the application. The trial
application removes the receipt directory and token from its environment at
startup, so rclone, scripts and restarted processes never inherit them.

Removing a variable does not erase the block the process was started with, so on
Linux `/proc/<pid>/environ` keeps showing `RCMAN_UPDATE_ARGS` (in the supervisor)
and the receipt directory and token (in the updated application) for the life of
the process. That file is readable only by the process owner and root, the same
audience as the service's own environment (for example `RCLONE_MANAGER_PASS`
from an `EnvironmentFile`). The updated application's command line, which
`ps` shows to every user, carries the launch arguments as well, so credentials
belong in the environment or an owner-only file rather than on the command line.
The block is not overwritten: the attempt token only separates a stale receipt
from a current one, and scrubbing the environment would not close the wider
command-line exposure.

Consecutive updates hand the next private staging directory to the same helper
after the current child exits cleanly. The helper validates the product, target,
signatures and increasing version again. No additional supervisor is retained.
Administrative stop takes precedence over a pending handoff. The supervisor uses
a single-thread runtime and stops polling readiness after commit.

Successful commitment removes the old executable backup. Completed inactive
staging directories for this executable are pruned on the next preparation;
file locks protect active supervisors. An executing Windows helper can remain
until a later cleanup after it exits. Failed/uncommitted attempts are retained for
manual diagnosis and recovery, with `failure.txt` when recovery was attempted.
User configuration, vaults and databases are never restored by this mechanism.

Apply failures returned by an installer preserve the downloaded payload for a
retry and publish a localized failure in the shared snapshot; a later check keeps
it until another release is found. A failed restart after Tauri installed an
update exits, so the installed build starts next. `get_app_update_info` and
`get_rclone_update_info` return the whole updater state, so a reloaded web UI or
another window shows the same picture: whether a check (including a scheduled
one) is running, when the last check finished and why it failed, updates rolled
back in this session (headless servers have no OS notifications), and the reminder
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

### Supervisor lifetime on Unix

The original process enters the helper with `exec`, so the supervisor keeps the
original PID and the updated application runs as its child. The supervisor does
not exit when the update commits: it keeps waiting until the application exits.
This is deliberate. Whatever launched the service tracks that PID:

- systemd (`Type=simple`) treats the main PID exiting as the service stopping
  and, with the default `KillMode=control-group`, ends the rest of the control
  group, including the updated child;
- a container ends when its main process exits;
- a terminal's job control and Ctrl+C address the foreground process.

After commit the supervisor only waits (about 10 MB resident) and forwards
SIGTERM and SIGINT to the child. It exits, and removes its staging directory,
when the application exits cleanly, when the service is stopped, or when it hands
over to a consecutive update. While the application runs, the `.rcman-update-*`
directory stays next to the executable. It holds no payload or backup after
commit, only a few small files: the lock that marks an active supervisor, the
receipt, `committed`, `target.json`, the manifest and its signature, and the
`next.json` handoff when one is pending. A rolled-back attempt keeps its directory
(with `failure.txt`) until the failure has been shown to the user.

Alternatives that would remove the resident supervisor were considered and not
taken:

- Exit after commit. This breaks the PID tracking above, so it would need
  detection of every launcher (systemd, containers, terminals) and fails silently
  when the guess is wrong.
- Replace in place and `exec` the new build, with a guard at the next start that
  restores the backup when the previous trial never committed. It keeps the PID
  and leaves no extra process, but a crash is only reversed on the next start, so
  it relies on a restart policy (for example systemd `Restart=`) or a manual
  start, and a pre-start self-check would be needed for builds that cannot load.
- Replace and restart without rollback, as `rclone selfupdate` does. A bad
  release would take unattended servers down.

Moving the post-commit state out of the installation directory would hide the
directory but not the process; it also touches the same-directory validation in
`validate_stage` and `prune_completed`, so it is not done either.

## Operational limits

The custom installer does not collect root/admin passwords or provision a
privileged maintenance service. Protected portable/server paths remain blocked;
administrators must use deployment tooling or arrange an owned, writable
installation. Tauri's native installers retain their platform authorization flows.
DEB and RPM updates need a session that can show Tauri's password prompt
(pkexec, zenity or kdialog); a headless service without one reports the failure
and keeps the verified download for a retry.

The startup trial covers the direct portable/server installer. Native Tauri
installers and Android's package installer do not acquire this supervisor or a
new rollback guarantee. Startup confirmation covers required local initialization and the listener/render
path, not every feature or future responsiveness. A build that crashes after its
receipt is not rolled back.

Rollback restores only the executable. It is not a transactional configuration,
vault, or database rollback. Releases with irreversible data migrations need an
explicit compatibility/migration strategy before enabling automatic binary
rollback. Recovery after power loss, supervisor termination, or OS reboot is not
automatically reconciled from a durable installation journal yet; keep the
recovery directory for manual repair. Windows replacement/restoration still has
a remove/rename gap. TUF metadata expiry/key rotation and staged rollouts are also
not implemented.

Real Windows/macOS installation, protected-directory behavior, and Android
installer dialogs require platform testing before release. CI runs the shared
updater unit tests on Linux, Windows, and macOS; the Android release workflow also
runs the APK identity validator tests.
Linux x86_64 tests additionally run the signed replacement and supervisor loop
in separate processes using a disposable public fixture key. They cover healthy
startup, crash rollback, payload tampering, consecutive updates, and administrative
shutdown. Production helper entry points always use the pinned production key.
