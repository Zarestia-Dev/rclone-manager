# 📦 Packaging & Distribution

This guide covers how to generate installers, packages, and Docker images for **RClone Manager**.

> **⚠️ Important Cross-Compilation Note:**
> Tauri **cannot** cross-compile native installers.
> * To build a **Windows** (`.exe`) installer, you must be on Windows.
> * To build a **macOS** (`.dmg`) installer, you must be on macOS.
> * To build **Linux** packages (`.deb`, `.rpm`), you must be on Linux.
>
> *For automated cross-platform builds, see the [CI/CD section](#-cicd-automation).*

---

## 🪟 Windows Packaging

### Standard Installer (NSIS & MSI)
Generates a standard setup wizard and a Microsoft Installer.

```bash
npm run tauri build

```

* **Output:** `src-tauri/target/release/bundle/nsis/*.exe`
* **Output:** `src-tauri/target/release/bundle/msi/*.msi`

### Portable Standalone

Generates a single `.exe` that does not require installation and saves config locally.

```bash
npm run tauri build -- --features portable --no-bundle

```

* **Output:** `src-tauri/target/release/rclone-manager.exe`

---

## 🐧 Linux Packaging

The Linux bundler uses the assets located in `src-tauri/linux/` (desktop files, icons) to generate distribution packages.

### Universal Bundles (.deb, .rpm, .AppImage)

By default, running the build command on Linux generates all configured formats in `tauri.conf.json`.

```bash
npm run tauri build

```

* **Output:** `src-tauri/target/release/bundle/deb/*.deb` (Debian/Ubuntu)
* **Output:** `src-tauri/target/release/bundle/rpm/*.rpm` (Fedora/RHEL)
* **Output:** `src-tauri/target/release/bundle/appimage/*.AppImage` (Universal)

### Flatpak

Packaging for Flathub requires a specific manifest and the `flatpak` feature flag to ensure path compliance.

1. **Build Binary:** `npm run tauri build -- --features flatpak`
2. **Builder:** Use `flatpak-builder` with the manifest located in the root (or `src-tauri/linux`).



### Portable Standalone

Generates a single binary that does not require installation and saves config locally.

```bash
npm run tauri build -- --features portable --no-bundle

```

* **Output:** `src-tauri/target/release/rclone-manager`
---

## 🍎 macOS Packaging

### DMG & App Bundle

Generates the standard Apple disk image and Application bundle.

```bash
npm run tauri build

```

* **Output:** `src-tauri/target/release/bundle/dmg/*.dmg`
* **Output:** `src-tauri/target/release/bundle/macos/RClone Manager.app`

### Code Signing & Notarization

To avoid "App Damaged" or "Unidentified Developer" warnings, you must sign the app.

* Set `APPLE_SIGNING_IDENTITY` and `APPLE_CERTIFICATE` environment variables.
* The build script will automatically attempt to sign if these are present.

---

## 🌐 Headless & Docker Packaging

The headless version is packaged differently since it serves a web UI instead of opening a window.

### 1. Build the Headless Binary

First, compile the binary with the web-server feature.

```bash
npm run tauri build -- --config src-tauri/tauri.conf.headless.json --features web-server,updater

```

* **Output:** `src-tauri/target/release/rclone-manager-headless` (Linux) or `.exe` (Windows). I only build for linux but headless mode works as well on Windows and MacOS to.

### 2. Build the Docker Image

Once the binary is built, you can package it into a container.

```bash
# From the project root
docker build -t rclone-manager:latest -f headless/Dockerfile .

```

---

## 🤖 CI/CD Automation

We utilize **GitHub Actions** to automate packaging for all platforms.

### 1. Desktop Releases

* **Workflow:** `.github/workflows/release.yml`
* **Trigger:** Manual (`workflow_dispatch`).
* **Actions:** Builds Windows, macOS, and Linux assets simultaneously and uploads them to the release page.

### 2. Headless Releases

* **Workflow:** `.github/workflows/release-headless.yml`
* **Trigger:** Manual (`workflow_dispatch`).
* **Tag Naming:** Releases are prefixed with `headless-v*`.
* **Architecture:** Builds binaries for both `x86_64` (Intel/AMD) and `aarch64` (ARM/Raspberry Pi) using a matrix strategy.
* **Command:**
```yaml
args: >-
  --config src-tauri/tauri.conf.headless.json
  --features web-server,updater
  --target ${{ matrix.arch }}-unknown-linux-gnu

```



### 3. Docker Registry

* **Workflow:** `.github/workflows/docker-build-push.yml`
* **Registry:** `ghcr.io` (GitHub Container Registry).
* **Architectures:** Multi-arch builds for `linux/amd64` and `linux/arm64`.
* **Process:**
1. Builds images for each architecture.
2. Pushes temporary tags (e.g., `:latest-amd64`).
3. Creates a **Manifest List** to merge them under a single tag (`:latest`), allowing users on any architecture to pull the same image name.