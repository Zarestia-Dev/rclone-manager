<p align="center">
  <img src="assets/App Banner.png" alt="RClone Manager">
</p>

<h1 align="center">
  RClone Manager
</h1>

<p align="center">
  <a href="README.md">🇺🇸 English</a> •
  <a href="README.tr-TR.md">🇹🇷 Türkçe</a> •
  <a href="CONTRIBUTING.md#adding-translations">Help to translate</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>A powerful, cross-platform GUI for managing Rclone remotes with style and ease.</b><br>
  <i>Built with Angular 21 + Tauri · Linux • Windows • macOS • ARM Support</i>
</p>

<p align="center">
  <a href="https://crowdin.com/project/rclone-manger">
    <img src="https://badges.crowdin.net/rclone-manger/localized.svg?style=for-the-badge" alt="Crowdin">
  </a>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs">
    <img src="https://img.shields.io/badge/📚_Documentation_Wiki-blue?style=for-the-badge" alt="Documentation">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=for-the-badge&color=2ec27e" alt="Latest Release">
  </a>
</p>

<p align="center">
  <a href="https://github.com/Zarestia-Dev/rclone-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/Zarestia-Dev/rclone-manager?style=flat&color=9141ac" alt="License">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/stargazers">
    <img src="https://img.shields.io/github/stars/Zarestia-Dev/rclone-manager?style=flat&color=3584e4" alt="Stars">
  </a>
</p>

---

## Overview

**RClone Manager** is a **modern, cross-platform GUI** that makes managing [Rclone](https://rclone.org/) remotes effortless. Whether you're syncing files across cloud storage providers, mounting remote drives, or performing complex file operations, RClone Manager provides an intuitive interface that simplifies even the most advanced Rclone features.

It also features a **built-in file manager (Nautilus)** that allows you to elegantly browse your remote files. You can display and edit files, move, delete, copy, and rename files and folders, as well as create new folders. The integrated file viewer lets you preview videos, images, PDFs, sound files, and text documents easily. It supports nearly all file operations, complete with right-click context menus and detailed properties modals!

> Big `RC` comes from `Rclone RC`.

<div align="center">
  
### 🌐 **Looking for Headless Mode?**
 
Check out **[RClone Manager Headless](headless/README.md)** – Run as a web server on Linux servers without a GUI!  
Perfect for NAS, VPS, and remote systems. Access from any browser. 🚀

</div>

Regular updates with new features and improvements. Check out our [roadmap](https://github.com/users/Zarestia-Dev/projects/2) to see what's coming next!

---

## 📸 Screenshots

<p align="center">
  <img src="assets/desktop-ui.png" alt="Desktop UI" width="40%">
</p>

<p align="center">

|                                Home                                 |                             Remote Overview                             |                             Mount Control                             |
| :-----------------------------------------------------------------: | :---------------------------------------------------------------------: | :-------------------------------------------------------------------: |
| <img src="assets/general-home.png" alt="General Home" width="250"/> | <img src="assets/general-remote.png" alt="General Remote" width="250"/> | <img src="assets/mount-control.png" alt="Mount Control" width="250"/> |

|                            Job Watcher                            |                             Serve Control                             |                          Dark Mode                          |
| :---------------------------------------------------------------: | :-------------------------------------------------------------------: | :---------------------------------------------------------: |
| <img src="assets/job-watcher.png" alt="Job Watcher" width="250"/> | <img src="assets/serve-control.png" alt="Serve Control" width="250"/> | <img src="assets/dark-ui.png" alt="Dark Mode" width="250"/> |

|                      Nautilus File Manager                      |                            File Viewer                            |                                                             |
| :-------------------------------------------------------------: | :---------------------------------------------------------------: | :---------------------------------------------------------: |
|  <img src="assets/nautilus.png" alt="Nautilus" width="250"/>    | <img src="assets/file-viewer.png" alt="File Viewer" width="250"/> |                                                             |

</p>

---

## 📦 Downloads

Install RClone Manager from your favorite package manager or download directly.

### Linux

| Repository          | Version                                                                                                                                                                                 | Install Command                                                                                                                                                             |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUR**             | [![AUR Version](https://img.shields.io/aur/version/rclone-manager?style=flat&label=)](https://aur.archlinux.org/packages/rclone-manager)                                                | `yay -S rclone-manager`                                                                                                                                                     |
| **AUR (Git)**       | [![AUR Version](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=)](https://aur.archlinux.org/packages/rclone-manager-git)                                        | `yay -S rclone-manager-git`                                                                                                                                                 |
| **Flathub**         | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/en/apps/io.github.zarestia_dev.rclone-manager)  | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                                                                     |
| **Direct Download** | [![Latest Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/latest"><img src="https://img.shields.io/badge/Download-3584e4?style=flat&logo=github" alt="Download"></a> |

> 📚 **Detailed Guide:** [Wiki: Installation - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux)  
> _Covers Flatpak troubleshooting._

### macOS

| Repository          | Version                                                                                                                                                                                 | Install Command                                                                                                                                                             |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Homebrew**        | ![Pending](https://img.shields.io/badge/Pending-gray?style=flat)                                                                                                                        | _Coming Soon_                                                                                                                                                               |
| **Direct Download** | [![Latest Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/latest"><img src="https://img.shields.io/badge/Download-3584e4?style=flat&logo=github" alt="Download"></a> |

> 📚 **Detailed Guide:** [Wiki: Installation - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos)  
> _Important: Read this for the "App is Damaged" fix and macFUSE setup._

### Windows

| Repository          | Version                                                                                                                                                                                 | Install Command                                                                                                                                                             |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chocolatey**      | [![Chocolatey](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                            | `choco install rclone-manager`                                                                                                                                              |
| **Scoop**           | [![Scoop](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json) | `scoop bucket add extras` then `scoop install rclone-manager`                                                                                                               |
| **Winget**          | ![Winget](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)                                                                                 | `winget install RClone-Manager.rclone-manager`                                                                                                                              |
| **Direct Download** | [![Latest Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/latest"><img src="https://img.shields.io/badge/Download-3584e4?style=flat&logo=github" alt="Download"></a> |

> 📚 **Detailed Guide:** [Wiki: Installation - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows)  
> _Includes instructions for WinFsp (required for mounting) and SmartScreen._

---

## 🛠️ System Requirements

RClone Manager handles most dependencies automatically.

- **Rclone:** The app will download it for you if missing.
- **Mounting (Optional):** Requires **WinFsp** (Windows), **macFUSE** (macOS), or **FUSE3** (Linux).
- **Details:** See **[Wiki: System Requirements](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies)** for full compatibility notes.

---

## 🛠️ Development

For building from source (Desktop, Headless, Docker, or Flatpak), please refer to the **[Building Guide](https://hakanismail.info/zarestia/rclone-manager/docs/building)**.

### Linting & Formatting

- See [**LINTING.md**](LINTING.md) for instructions on maintaining code quality.

---

## 🐞 Troubleshooting

Encountering an issue?

1.  Check the **[Troubleshooting Wiki](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting)** for common fixes (Mount errors, Permissions, App Launch issues).
2.  Check [**ISSUES.md**](ISSUES.md) for platform-specific known limitations.
3.  Visit the [**GitHub Project Board**](https://github.com/users/Zarestia-Dev/projects/2) to see what we are working on.

---

## 🤝 Contributing

We welcome contributions! Here's how you can help:

- 🌍 **Help Translate** – Check the [Add Translations Guide](CONTRIBUTING.md#adding-translations)
- 🐛 **Report Bugs** – [Open a bug report](https://github.com/Zarestia-Dev/rclone-manager/issues/new?template=bug_report.md)
- 💡 **Suggest Features** – [Share your ideas](https://github.com/Zarestia-Dev/rclone-manager/issues/new?template=feature_request.md)
- 📖 **Improve Docs** – Help make our [documentation](https://hakanismail.info/zarestia/rclone-manager/docs) clearer
- 🔧 **Submit PRs** – Check the [CONTRIBUTING.md](CONTRIBUTING.md)
- 💬 **Discuss** – Join [GitHub Discussions](https://github.com/Zarestia-Dev/rclone-manager/discussions)

---

## 📜 License

Licensed under **[GNU GPLv3](LICENSE)** – free to use, modify, and distribute.

---

## ⭐ Support the Project

- **Star** and **Watch** the repo to stay updated on releases
- Share with friends and spread the world!

---

<p align="center">
  Made with ❤️ by the Zarestia Dev Team<br>
  <sub>Powered by Rclone | Built with Angular & Tauri</sub>
</p>
