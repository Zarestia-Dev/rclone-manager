# 🔨 Building from Source

This guide explains how to set up your development environment and compile **RClone Manager** from source code.

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

1.  **Node.js (v18+)**: [Download Node.js](https://nodejs.org/)
2.  **Rust (Latest Stable)**:
    ```bash
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs| sh
    ```
3.  **OS Dependencies**:
    * **Windows**: Microsoft Visual Studio C++ Build Tools.
    * **Linux**: WebKit2GTK and base build tools (`build-essential`, `libwebkit2gtk-4.0-dev`, `libssl-dev`, etc.).
    * **macOS**: Xcode Command Line Tools (`xcode-select --install`).

> For a complete list of Tauri prerequisites, see the [Tauri Guides](https://tauri.app/start/prerequisites/).

---

## ⚡ Quick Start (Standard Desktop)

If you just want to build the standard desktop application:

### 1. Clone the Repository
```bash
git clone https://github.com/Zarestia-Dev/rclone-manager.git
cd rclone-manager

```

### 2. Install Dependencies

```bash
npm install

```

### 3. Run in Development Mode

This starts the Angular frontend and the Tauri backend with hot-reload enabled.

```bash
npm run tauri dev

```

### 4. Production Build

To compile a minimized, optimized binary for your current machine:

```bash
npm run tauri build

```

*Outputs: `src-tauri/target/release/*`

---

## 🔧 Advanced Build Configurations

RClone Manager supports different "Flavors" (Headless, Portable, Flatpak) using **Cargo Features** and specific configuration files.

> **Note on Syntax:** The extra `--` in the commands below is required to pass arguments through NPM to the underlying Tauri CLI.

### 🌐 Headless Mode

Builds the server-only version (no GUI window) that runs in a terminal and serves the UI via HTTP or HTTPS (If the certificates have been configured).

* **Config:** Uses a separate `tauri.conf.headless.json` to strip GUI permissions.
* **Features:** Enables `web-server` and `updater`.

```bash
# Development
npm run tauri dev -- --config src-tauri/tauri.conf.headless.json --features web-server,updater

# Production Build
npm run tauri build -- --config src-tauri/tauri.conf.headless.json --features web-server,updater

```

### 📦 Portable Mode (Windows and Linux)

Builds a self-contained executable. Ideal for USB drives or running without admin privileges.

* **Features:** Enables `portable` (configures app to store data locally alongside the executable).

```bash
# Development (No bundling)
npm run tauri dev -- --features portable

# Production Build
npm run tauri build -- --features portable --no-bundle # We don't need a bundle installer.

```

### 🧊 Flatpak Version (Linux)

Builds with specific adjustments for the Flatpak sandboxed environment (e.g., special startup script handler, disable updater).

* **Features:** Enables `flatpak`.

```bash
# Development
npm run tauri dev -- --features flatpak

# Production Build
npm run tauri build -- --features flatpak

```

## 🐧 Linux Specific Assets

The `src-tauri/linux` directory contains special handle files used during the Linux build and packaging process:

* **`rclone-manager.desktop`**: The system desktop entry file.
* **`flatpak.metainfo.xml`**: Flathub app page configuration file
* **`headless`**: Helper postinstall and preremove scripts and custom desktop files for the headless version.

*These are automatically utilized by the build scripts when the relevant features are enabled.*

---

## 🐞 Troubleshooting Build Errors

* **Rust Errors:** Run `cargo update` inside the `src-tauri` folder to ensure dependencies are fresh.
* **WebView2 (Windows):** Ensure you have the WebView2 runtime installed.
* **Pkg-config (Linux):** If the build fails on Linux, you are likely missing a system library. Check the error log for missing headers (usually `librsvg`, `libappindicator3`, or `webkit2gtk`).