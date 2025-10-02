<h1 align="center">
  <img src="src/assets/rclone.svg" alt="RClone Manager" height="180">
  <br>
  RClone Manager
</h1>

<p align="center">
  <b>A powerful, cross-platform GUI for managing Rclone remotes with style and ease.</b><br>
  <i>Built with Angular 20 + Tauri 2 · Linux • Windows • macOS • ARM Support</i>
</p>

<p align="center">
  <a href="https://github.com/RClone-Manager/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/RClone-Manager/rclone-manager?style=flat-square" alt="Latest Release">
  </a>
  <a href="https://github.com/RClone-Manager/rclone-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/RClone-Manager/rclone-manager?style=flat-square" alt="License">
  </a>
  <a href="https://github.com/RClone-Manager/rclone-manager/stargazers">
    <img src="https://img.shields.io/github/stars/RClone-Manager/rclone-manager?style=flat-square" alt="Stars">
  </a>
</p>

---

## 🌐 Overview

**RClone Manager** is a **modern, cross-platform GUI** that makes managing [Rclone](https://rclone.org/) remotes effortless. Whether you're syncing files across cloud storage providers, mounting remote drives, or performing complex file operations, RClone Manager provides an intuitive interface that simplifies even the most advanced Rclone features.

> ⚠️ **Actively developed** – Regular updates with new features and improvements. Check out our [roadmap](#-roadmap) to see what's coming next!

---

## 🎨 Design Philosophy

💡 **Beautiful by design.** A unique blend of **GTK styling**, **Angular Material**, and **FontAwesome icons** creates a clean, minimalist interface that feels at home on any platform while maintaining a modern, responsive experience.

---

## 📸 Screenshots

<p align="center">
  <strong>💻 Desktop Interface</strong><br/>
  <img src="assets/desktop-ui.png" alt="Desktop UI" width="700"/>
</p>

<p align="center">
  <strong>🏠 Home & Overview</strong><br/>
  <img src="assets/general-home.png" alt="General Home" width="350"/>
  <img src="assets/general-remote.png" alt="General Remote" width="350"/>
</p>

<p align="center">
  <strong>⚙️ Mount Control & Job Monitoring</strong><br/>
  <img src="assets/mount-control.png" alt="Mount Control" width="350"/>
  <img src="assets/job-watcher.png" alt="Job Watcher" width="350"/>
</p>

<p align="center">
  <strong>📱 Mobile Support</strong><br/>
  <img src="assets/mobile-ui.png" alt="Mobile UI" width="250"/>
</p>

<p align="center">
  <em>Seamlessly switches between light and dark modes to match your system preferences.</em>
</p>

---

## 🚀 Features

### 🎯 Core Functionality

- 🛠 **Complete Remote Management** – Add, edit, delete, and clone remotes with an intuitive wizard
- 🔐 **OAuth & Interactive Configuration** – Seamless authentication with providers like OneDrive, Google Drive, and iCloud
- 🔑 **Encrypted Configuration Support** – Secure password storage using system keyring/credential store
- 💾 **Import/Export** – Backup and restore your entire configuration, with optional 7z encryption

### ⚡ File Operations

- 📁 **Mount Remotes** – Access cloud storage as local drives with multiple mount types (mount, mount2, NFS)
- 🔄 **Sync & Copy** – One-way synchronization and file copying between remotes or local folders
- ↔️ **Bidirectional Sync (Bisync)** – Keep two locations perfectly synchronized in both directions
- 🚚 **Move Operations** – Transfer files between locations without leaving duplicates
- 🎯 **Primary Actions** – Set up to 3 quick-access actions per remote for instant operations

### 🎨 User Experience

- 🌗 **Adaptive Themes** – Beautiful light and dark modes with GTK-inspired design
- 🖥 **System Tray Integration** – Quick access to mounts and operations from your taskbar
- 📊 **Real-time Monitoring** – Live job status, transfer speeds, and progress tracking
- 🔔 **Smart Notifications** – Stay informed with non-intrusive alerts
- ⚙️ **Advanced Options** – Full access to VFS settings, bandwidth limits, and flag configurations

### 🌍 Platform Support

- 🐧 **Linux** – Full support including ARM architecture
- 🪟 **Windows** – Native support with WinFsp integration, including ARM
- 🍎 **macOS** – Complete functionality with automatic mount plugin installation
- 📱 **Responsive Design** – Optimized interface for desktop and mobile viewports

### 🔧 Advanced Features

- 🔄 **Auto-Update** – Built-in updater keeps you on the latest version
- 🖥️ **Native Terminal Support** – Open remote config in your preferred terminal
- 📡 **Metered Connection Detection** – Smart warnings when on limited networks
- 🎮 **Global Shortcuts** – Keyboard shortcuts for power users (e.g., Ctrl+Shift+M to force-check mounts)
- 🔍 **Mount Watcher** – Automatic detection and updates of mount status

### ☁️ Supported Cloud Providers

Nearly all Rclone remotes are supported, including:

- **Google Drive** – Full OAuth support with team drives
- **Microsoft OneDrive** – Personal and Business accounts
- **Dropbox** – Complete integration
- **Amazon S3** – And all S3-compatible services
- **iCloud Drive** – Interactive configuration support
- **SFTP/FTP** – Secure file transfer protocols
- **WebDAV** – Generic WebDAV support
- **And 40+ more providers!**

---

## 🔧 Tech Stack

- **Frontend**: Angular 20 + Angular Material + FontAwesome
- **Backend**: Tauri 2 (Rust)
- **Styling**: Custom GTK-inspired theming with responsive design
- **Architecture**: Modern component-based with reactive state management

---

## 📦 Downloads

### 🎯 Latest Release

Get the latest version for your platform:

<p align="center">
  <a href="https://github.com/RClone-Manager/rclone-manager/releases/latest">
    <img src="https://img.shields.io/badge/Download-Latest%20Release-blue?style=for-the-badge&logo=github" alt="Download Latest Release">
  </a>
</p>

**Available for:**

- 🐧 Linux (x86_64, ARM64) – AppImage, Deb, RPM
- 🪟 Windows (x86_64, ARM64) – MSI Installer, Portable
- 🍎 macOS (Intel, Apple Silicon) – DMG

> 📋 See the [full release notes](https://github.com/RClone-Manager/rclone-manager/releases) for changelog and installation instructions

---

## 🛠️ Installation

### 📋 Runtime Requirements

**RClone Manager** will guide you through installing any missing dependencies on first run. However, you can pre-install:

#### Required

- **[Rclone](https://rclone.org/downloads/)** – The core tool for remote management (can be installed via the app)

#### Optional (for mounting)

- **Linux/macOS:** [FUSE](https://github.com/libfuse/libfuse) – Usually pre-installed on most distributions
- **Windows:** [WinFsp](https://github.com/billziss-gh/winfsp) – Automatically prompted for installation if missing
- **macOS:** Mount plugin – Automatically installed by the app when needed

#### Optional (for encrypted exports)

- **[7-Zip](https://www.7-zip.org/)** – For password-protected configuration backups

### 🚀 Quick Start

1. **Download** the appropriate package for your OS from [releases](https://github.com/RClone-Manager/rclone-manager/releases/latest)
2. **Install** using your platform's standard method:

- **Linux:**
  - **Debian/Ubuntu:** `sudo dpkg -i rclone-manager_*.deb` or run the AppImage
  - **Fedora/openSUSE (RPM):** `sudo rpm -i rclone-manager-*.rpm`
  - **Arch Linux:** Install from [AUR](https://aur.archlinux.org/packages/rclone-manager) via your AUR helper, e.g. `yay -S rclone-manager`
- **Windows:** Run the MSI installer or extract the portable version
- **macOS:** Open the DMG and drag to Applications

3. **Launch** RClone Manager and follow the onboarding wizard
4. **Add your first remote** using the guided setup

> 💡 **First-time users?** The app includes an interactive onboarding that will help you set up Rclone and create your first remote!

---

## 🛠️ Development

### Prerequisites for Building

- **[Node.js](https://nodejs.org/)** (v18 or later)
- **[Rust](https://www.rust-lang.org/tools/install)** (latest stable)
- **[Cargo](https://doc.rust-lang.org/cargo/)** (comes with Rust)
- Platform-specific build tools (see [Tauri prerequisites](https://tauri.app/v2/guides/prerequisites/))

### Development Setup

```bash
# Clone the repository
git clone https://github.com/RClone-Manager/rclone-manager.git
cd rclone-manager

# Install dependencies
npm install

# Start development server
npm run tauri dev
```

⚠️ **Important:** Always use `npm run tauri dev` instead of `ng serve`, as the app requires Tauri APIs.

### Building for Production

```bash
# Build for your current platform
npm run tauri build

# The built application will be in src-tauri/target/release/
```

### Linting & Formatting

```bash
# Frontend (Angular)
npm run lint          # ESLint check
npm run format        # Prettier format

# Backend (Rust)
npm run lint:rust     # Clippy check
npm run format:rust   # Rustfmt format
```

---

## 🐞 Known Issues

Known bugs and technical limitations are tracked in two places:

- 📄 See [**ISSUES.md**](ISSUES.md) for detailed explanations of platform-specific issues (e.g. Windows terminal flash)
- 📌 Visit our [**GitHub Project Board**](https://github.com/users/RClone-Manager/projects/6) for open bugs and upcoming fixes

---

## 🗺️ Roadmap

We organize development on our [**GitHub Project Board**](https://github.com/users/RClone-Manager/projects/6) — track features, bugs, and long-term goals.

### Current Focus Areas

- 🔜 **Near-Term Goals**
  - Enhanced job monitoring with detailed progress tracking
  - Additional filter configuration options
  - Performance optimizations for large remote lists
- 🚀 **Long-Term Vision**
  - Multi-language support (i18n/l10n)
  - Mobile app versions
  - Advanced scheduling and automation
  - Plugin system for custom integrations

- 🧩 **Community Driven**
  - Feature requests and suggestions
  - UI/UX improvements
  - Platform-specific enhancements

> 🧠 **Want to influence the direction?** Star the repo, watch the project board, and share your ideas in [Discussions](https://github.com/RClone-Manager/rclone-manager/discussions) or [Issues](https://github.com/RClone-Manager/rclone-manager/issues)!

---

## 🤝 Contributing

We welcome contributions from developers of all skill levels! Here's how you can help:

### Ways to Contribute

- 🐛 **Report Bugs** – Found an issue? [Open a bug report](https://github.com/RClone-Manager/rclone-manager/issues/new?template=bug_report.md)
- 💡 **Suggest Features** – Have an idea? [Share it with us](https://github.com/RClone-Manager/rclone-manager/issues/new?template=feature_request.md)
- � **Improve Documentation** – Help make our docs clearer and more comprehensive
- 🔧 **Submit Pull Requests** – Fix bugs or implement features (see development setup above)
- 🌍 **Translate** – Help make RClone Manager available in your language (coming soon)
- ⭐ **Spread the Word** – Star the repo, share with friends, write blog posts

### Contribution Guidelines

1. Fork the repository and create a feature branch
2. Follow the existing code style and linting rules
3. Test your changes thoroughly on your target platform
4. Write clear commit messages
5. Submit a pull request with a detailed description

> 📝 See our [CONTRIBUTING.md](CONTRIBUTING.md) guide (coming soon) for detailed guidelines

---

## 📜 License

Licensed under the **[GNU GPLv3](LICENSE)**.

You are free to use, modify, and distribute this software under the terms of the GPL v3 license. See the [LICENSE](LICENSE) file for full details.

---

## 📬 Support & Contact

### Get Help

- 💬 [GitHub Discussions](https://github.com/RClone-Manager/rclone-manager/discussions) – Ask questions and chat with the community
- 🐛 [Issue Tracker](https://github.com/RClone-Manager/rclone-manager/issues) – Report bugs or request features
- 📖 [Documentation](https://github.com/RClone-Manager/rclone-manager/wiki) – Guides and tutorials (coming soon)

### Stay Updated

- ⭐ Star the repository to get notifications about new releases
- 👀 Watch the repo for all updates and discussions
- 🔔 Enable release notifications to be the first to know about new versions

---

<p align="center">
  Made with ❤️ by the RClone Manager Team<br>
  <sub>Powered by Rclone | Built with Angular & Tauri</sub>
</p>
