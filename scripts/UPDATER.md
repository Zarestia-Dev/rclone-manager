# Release update manifests

Every installation is updated by the core updater from **`updater.json`**. Tauri's own
updater is gone. `latest.json` and the `.sig` files that `tauri-action@v1` writes
(`createUpdaterArtifacts: true`, `uploadUpdaterSignatures: false`) are still published
only for the desktop versions that shipped Tauri's plugin (0.3.7 and older): they
update once through Tauri to the first release that has the core updater. Delete
`createUpdaterArtifacts`, `plugins.updater` in `tauri.conf.json` (the CLI needs it,
with its `pubkey`, for those artifacts, and only warns when the signing key does not
match it) and the
`latest.json` handling after the release that follows it.

Tauri never writes `updater.json`. Each release has its own catalog:

```json
{
  "schemaVersion": 1,
  "version": "1.2.3",
  "entries": {
    "portable-windows-x86_64": {
      "manifest": "BASE64_OF_EXACT_SIGNED_MANIFEST_BYTES",
      "signature": "TAURI_SIGNER_MANIFEST_SIGNATURE"
    }
  }
}
```

Each decoded manifest retains the existing `version`, `kind`, `target`, `asset`,
`size`, `sha256`, and payload `signature` fields. The app downloads the release
file named `asset` from the address GitHub gives it. It verifies the exact signed
bytes, so they are encoded rather than re-serialized, and it reads only its own
entry. Versions up to 0.3.7-beta.1 reject any field they do not know in the
catalog, an entry or a manifest, and never update again: the catalog keeps its
three fields, every entry `manifest` and `signature`, and the manifests of the
kinds those versions read keep these fields. Only a new kind's manifest may add
one.
Both metadata and payload signatures are verified with the production public key.
The catalog's version and selected entry's signed version, product, and architecture
must match the selected release and installation. Unsupported schemas or invalid
signatures fail; a valid catalog without the requested target offers no update.

`create-update-manifest.cjs` signs payloads and builds a local catalog. Matrix jobs
retain separate artifact directories until upload, avoiding same-name overwrites.
`publish-custom-updater.cjs` combines their catalogs with any existing draft-release
catalog, replacing rebuilt targets while preserving other products and architectures.
It refuses to modify a published release. Payloads must be uploaded before the catalog:
it fails when an entry's `asset` is not a file of the release, so a renamed or missing
file stops the release instead of every installation that would download it.
Portable and Android workflows run the publisher's `--check tag version` mode
before uploading any release payloads. This read-only check allows a missing or
draft release and fails on a published release or an API error. Catalog publication
also checks the release state again. Preflight filters the paginated release list
inside `gh`, returning only the requested tag and draft status to Node so release
bodies and asset lists cannot overflow its process-output buffer.

Portable and Android upload jobs share the `publish-custom-updater-main` concurrency
group to serialize the catalog's read/merge/upload operation. Their builds run outside
the lock; Android transfers its APKs and signed catalog together as a workflow artifact.
Server builds also run outside the lock, and their upload job prepares the shared
draft and publishes the catalog under the `release-server` group. Both groups use `queue: max` so additional pending publishers
do not replace earlier queued jobs. Any additional writer must join the relevant
group. These jobs do not publish the local signature sidecars or individual per-target
JSON files.

Clients read only the catalog: a release without `updater.json` is not offered to
direct installers. No published release ever carried per-target manifests (releases
before 0.3.4 have no signed metadata at all), so there is no legacy format to keep.
Do not alter previously published releases.

Standalone server releases publish one ZIP per OS and architecture, plus the custom
catalog:

```text
server-linux-x86_64-1.2.3.zip
server-windows-aarch64-1.2.3.zip
server-macos-aarch64-1.2.3.zip
```

Each ZIP contains `rclone-manager-server/` with the executable (`.exe` on Windows),
`LICENSE`, `README.txt` and, on Linux, the systemd unit template. It uses the same
signed `archive` metadata as portable packages, with `binaryPath` set to
`rclone-manager-server/rclone-manager-server[.exe]`. The same ZIP serves manual
downloads and automatic updates, which extract only the executable. Server ZIPs
never contain an application bundle, including on macOS. A server manifest without
`archive` is invalid.
There are no separate checksum files.

Android publishes one `android-<arch>-<version>.apk` per architecture from
`updater-assets/`. Both manual downloads and automatic updates use that APK.
`dist_apks/` is only an intermediate signing directory and is not uploaded to the release.

Portable releases publish one ZIP per OS and architecture:

```text
portable-windows-x86_64-1.2.3.zip
portable-windows-aarch64-1.2.3.zip
portable-linux-x86_64-1.2.3.zip
portable-linux-aarch64-1.2.3.zip
portable-macos-x86_64-1.2.3.zip
portable-macos-aarch64-1.2.3.zip
```

The same ZIP is used for initial installation and updates. The signed manifest's
existing `size`, `sha256`, and `signature` describe the executable. Its `archive`
object contains the ZIP's own `size`, `sha256`, `signature`, and the exact
`binaryPath` inside it. The updater verifies the ZIP, reads the named executable
using the shared ZIP helpers, and verifies that executable separately.
No additional archive dependencies or sidecar files are needed.

The custom updater's public key lives in `resources/updater.pub`. Within the Rust updater,
`manifest.rs` owns the signed schema and payload verification, `download.rs` owns
HTTPS and cache I/O, and `signed.rs` adapts these to the shared installation flow.
ZIP operations shared with Rclone provisioning live in `utils/archive.rs`.
`utils/app/paths.rs` resolves the installation directory for portable data,
permission checks and the replacement, including macOS app bundles.

Windows/Linux packages include `RCloneManager/` with the executable, initial
settings, and localized READMEs. Updates extract only the executable, so the
packaged default settings never overwrite the user's configuration.

macOS packages contain the complete `RClone Manager.app` bundle. Config and cache
directories are created beside the `.app`, outside its signed contents. Updates
verify the ZIP and its executable, extract the entire app beside it, and replace the
complete bundle, including `Info.plist` and code-signing resources. User data is never
inside the replaced bundle. Apple signing/notarization remains separate from
the updater's Tauri signatures; macOS builds need validation on a Mac.

AppImages are published by Tauri as `RClone.Manager_<version>_<amd64|aarch64>.AppImage`
(GitHub stores the bundle's spaces as dots). The desktop release signs that same file
as an `appimage-linux-<arch>` entry, whose `asset` is the GitHub name: there is no
second copy and no archive. The `publish-catalog` job merges these entries under the
`publish-custom-updater-main` group, after every bundle has been uploaded. The core
updater only treats a build as an AppImage when Tauri bundled it as one and the
AppImage runtime set `$APPIMAGE`; it replaces that file, never the executable in the
read-only mount, and restarts from it as portable builds do. Replacing an AppImage never asks for a password: it must be owned by the
current user in a writable folder.

## Desktop installs

The desktop release (`v<version>`, `release-desktop.yml`) signs these entries into the
same `updater.json` that the portable and Android builds fill. Each file is uploaded
to the draft release before the catalog is published:

| Entry                                       | File                                                                                                                                                                    | Replaced by                                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appimage-linux-<arch>`                     | the Tauri AppImage                                                                                                                                                      | the core, in place                                                                                                                                                    |
| `deb-linux-<arch>`                          | the Tauri DEB                                                                                                                                                           | `dpkg -i` as root                                                                                                                                                     |
| `rpm-linux-<arch>`                          | the Tauri RPM                                                                                                                                                           | `rpm -U --oldpackage` as root                                                                                                                                         |
| `pacman-linux-<arch>`                       | `RClone.Manager-<version>-1-<arch>.pkg.tar.zst`, built by nfpm from the DEB's files (`backend/desktop/linux/nfpm.yaml`); the AUR package `rclone-manager` repackages it | `pacman -U` as root                                                                                                                                                   |
| `nsis-windows-<arch>`, `msi-windows-<arch>` | the Tauri setup and MSI                                                                                                                                                 | the installer, started once the app has exited (`/P /UPDATE` for the setup: without `/UPDATE` its old uninstaller removes the shortcuts and the start-at-login entry) |
| `app-macos-<arch>`                          | `app-macos-<arch>-<version>.zip`, the `.app` made by `ditto -c -k --keepParent`                                                                                         | the core, replacing the whole bundle                                                                                                                                  |

`app` is its own kind because the portable macOS build puts the same kind of ZIP under
`portable-macos-<arch>` in the same catalog.

Which entry an installation takes is decided by what the build was bundled as, which the
Tauri bundler patches into the binary (`tauri::utils::platform::bundle_type`), and, for
Linux packages, by the package manager that owns the executable: pacman owning a DEB
build means the Arch or AUR package.

Administrator rights are asked by the operating system, never by the app: `pkexec` (or
`sudo -A` with a zenity or kdialog password dialog) on Linux, the installer's own
elevation on Windows, and `osascript ... with administrator privileges` on macOS, which
the macOS app uses only when its folder is not the user's (`/Applications` for a
non-admin user). No password crosses the app, IPC or HTTP. Where none of these is
available, the user gets the command that installs the downloaded package.
