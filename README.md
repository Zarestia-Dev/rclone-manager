<p align="center">
  <img src="assets/App Banner.png" alt="RClone Manager">
</p>

<h1 align="center">RClone Manager</h1>

<p align="center">
  <a href="README.md">🇺🇸 English</a> •
  <a href="README.tr-TR.md">🇹🇷 Türkçe</a> •
  <a href="README.zh-CN.md">🇨🇳 简体中文</a> •
  <a href="README.fr-FR.md">🇫🇷 Français</a> •
  <a href="README.es-ES.md">🇪🇸 Español</a> •
  <a href="CONTRIBUTING.md#adding-translations">Help to translate</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>A powerful, cross-platform GUI for managing Rclone remotes with style and ease.</b><br>
  <i>Built with Angular 21 + Tauri · Linux • Windows • macOS • ARM Support</i>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs">
    <img src="https://img.shields.io/badge/📚_Documentation_Wiki-blue?style=flat-square" alt="Documentation">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat-square&color=2ec27e" alt="Latest Release">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/Zarestia-Dev/rclone-manager?style=flat-square&color=9141ac" alt="License">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/stargazers">
    <img src="https://img.shields.io/github/stars/Zarestia-Dev/rclone-manager?style=flat-square&color=3584e4" alt="Stars">
  </a>
  <a href="https://crowdin.com/project/rclone-manger">
    <img src="https://badges.crowdin.net/rclone-manger/localized.svg?style=flat-square" alt="Crowdin Status">
  </a>
</p>

---

## Overview

**RClone Manager** simplifies remote file management and synchronization. Using Rclone as its backbone, it offers a desktop environment with a built-in file manager (**Nautilus**) to transfer, mount, and serve remote files effortlessly.

- 📂 **Nautilus File Manager:** Browse, edit, move, copy, rename, and delete remote files.
- 👁️ **File Viewer:** Inline previews for videos, images, PDFs, audio, and text.
- ⚙️ **Mount & Serve:** Easy mount controls and serve management (WebDAV, SFTP, HTTP, FTP).
- 🔄 **Job Watcher:** Real-time transfer monitoring and bandwidth control.
- 🌐 **Headless Mode:** Check out [RClone Manager Headless](headless/README.md) to run as a web server on VPS/NAS!

---

## Screenshot

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="RClone Manager Desktop UI" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 Want to see more? Check out the <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Wiki Gallery</a></b> for all features.</i>
</p>

---

## Installation & Downloads

Install RClone Manager using your preferred package manager, or download standalone binaries directly from the [Releases](https://github.com/Zarestia-Dev/rclone-manager/releases) page.

### Linux

| Source              | Install Command / Download                                                                                                 |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------- |
| **AUR**             | `yay -S rclone-manager`                                                                                                    |
| **AUR (Git)**       | `yay -S rclone-manager-git`                                                                                                |
| **Flathub**         | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                    |
| **Direct Download** | [Latest Releases (.deb, .rpm, .AppImage, Portable tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guide:** [Wiki: Installation - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) (troubleshooting Flatpak, snapshots, etc.)

### macOS

| Source              | Install Command / Download                                                      |
| :------------------ | :------------------------------------------------------------------------------ |
| **Homebrew**        | `brew tap Zarestia-Dev/zarestia && brew install --cask rclone-manager`          |
| **Direct Download** | [DMG Installer](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guide:** [Wiki: Installation - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) (macFUSE & Gatekeeper fixes)

### Windows

| Source              | Install Command / Download                                                                 |
| :------------------ | :----------------------------------------------------------------------------------------- |
| **Winget**          | `winget install RClone-Manager.rclone-manager`                                             |
| **Chocolatey**      | `choco install rclone-manager`                                                             |
| **Scoop**           | `scoop bucket add extras && scoop install rclone-manager`                                  |
| **Direct Download** | [Installer / Portable EXE](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guide:** [Wiki: Installation - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) (WinFsp mounting requirements & SmartScreen)

> 🛠️ **System Requirements:** Mounting drives requires WinFsp (Windows), macFUSE (macOS), or FUSE3 (Linux). Rclone itself is downloaded automatically if missing. See [Wiki: System Requirements](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies).

---

## Development & Support

- **Building from Source:** Refer to the [Building Guide](https://hakanismail.info/zarestia/rclone-manager/docs/building).
- **Code Quality:** Check out [LINTING.md](LINTING.md) for style guidelines.
- **Troubleshooting:** Visit our [Troubleshooting Wiki](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) or read [ISSUES.md](ISSUES.md) for platform-specific notes.

---

## Contributing

We welcome contributions of all forms!

- 🌍 **Translations:** Join the [Crowdin Project](https://crowdin.com/project/rclone-manger) or read the [Translation Guide](CONTRIBUTING.md#adding-translations).
- 🐛 **Bugs & Features:** Open an [issue](https://github.com/Zarestia-Dev/rclone-manager/issues) or check the [Project Board](https://github.com/users/Zarestia-Dev/projects/2).
- 🔧 **Code changes:** Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a Pull Request.

---

## License & Support

- **License:** Licensed under the [GNU GPLv3](LICENSE) – free to use, modify, and distribute.
- **Support:** If you like this project, please consider leaving a ⭐ on GitHub!

<p align="center">
  Made with ❤️ by the Zarestia Dev Team<br>
  <sub>Powered by Rclone | Built with Angular & Tauri</sub>
</p>
