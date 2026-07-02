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
  <a href="CONTRIBUTING.md#adding-translations">帮助翻译</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>一个强大且跨平台的 GUI，用于以时尚、轻松的方式管理 Rclone 远程连接。</b><br>
  <i>使用 Angular 22 + Tauri 构建 · 支持 Linux • Windows • macOS • ARM</i>
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
  <a href="https://hakanismail.info/zarestia/donate">
    <img src="https://img.shields.io/badge/Donate-ea4aaa?style=flat-square" alt="Donate">
  </a>
</p>

---

## 项目概述

**RClone Manager** 简化了远程文件管理和同步。以 Rclone 为核心骨架，它提供了一个带有内置文件管理器（**Nautilus**）的桌面环境，使您可以轻松传输、挂载和提供远程文件服务。

- 📂 **Nautilus 文件管理器:** 浏览、编辑、移动、复制、重命名和删除远程文件。
- 👁️ **文件查看器:** 视频、图像、PDF、音频和文本的行内预览。
- ⚙️ **挂载与服务:** 简便的挂载控制和服务管理（WebDAV、SFTP、HTTP、FTP）。
- 🔄 **任务监视器:** 实时传输监控和带宽控制。
- 🌐 **无头（Headless）模式:** 访问 [RClone Manager Headless](headless/README.md) 在 VPS/NAS 上将其作为 Web 服务器运行！

---

## 界面截图

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="RClone Manager Desktop UI" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 想了解更多？请访问 <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Wiki 画廊</a></b> 了解所有功能。</i>
</p>

---

## 安装与下载

使用您偏好的包管理器安装 RClone Manager，或直接从 [发布页面](https://github.com/Zarestia-Dev/rclone-manager/releases) 下载独立二进制文件。

### Linux

| 来源         | 版本 | 安装命令 / 下载                                                                                                     |
| :----------- | :--- | :------------------------------------------------------------------------------------------------------------------ |
| **AUR**      | [![AUR 版本](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager) | `yay -S rclone-manager` |
| **AUR (Git)** | [![AUR 版本](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git) | `yay -S rclone-manager-git` |
| **Flathub**  | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager) | `flatpak install io.github.zarestia_dev.rclone-manager` |
| **直接下载** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [最新版本 (.deb, .rpm, .AppImage, Portable tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **指南:** [Wiki: 安装 - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux)（Flatpak 问题排查、Snap 等）

### macOS

| 来源         | 版本 | 安装命令 / 下载                                                              |
| :----------- | :--- | :--------------------------------------------------------------------------- |
| **Homebrew** | [![Homebrew 版本](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew install --cask rclone-manager` |
| **直接下载** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [DMG 安装包](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **指南:** [Wiki: 安装 - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos)（macFUSE 与 Gatekeeper 修复）

### Windows

| 来源           | 版本 | 安装命令 / 下载                                                                       |
| :------------- | :--- | :------------------------------------------------------------------------------------ |
| **Winget**     | [![Winget 版本](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager` |
| **Chocolatey** | [![Chocolatey 版本](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager) | `choco install rclone-manager` |
| **Scoop**      | [![Scoop 版本](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json) | `scoop bucket add extras && scoop install rclone-manager` |
| **直接下载**   | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [安装包 / 便携式 EXE](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **指南:** [Wiki: 安装 - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows)（WinFsp 挂载要求与 SmartScreen）

> 🛠️ **系统要求:** 挂载驱动器需要 WinFsp (Windows)、macFUSE (macOS) 或 FUSE3 (Linux)。如果缺失，Rclone 本身会自动下载。参见 [Wiki: 系统要求](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies)。

---

## 开发与支持

- **从源码构建:** 参考 [构建指南](https://hakanismail.info/zarestia/rclone-manager/docs/building)。
- **代码质量:** 访问 [LINTING.md](LINTING.md) 获取样式指南。
- **问题排查:** 访问我们的 [问题排查 Wiki](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) 或阅读 [ISSUES.md](ISSUES.md) 以获取平台特定的说明。

---

## 参与贡献

我们欢迎任何形式的贡献！

- 🌍 **翻译:** 加入 [Crowdin 项目](https://crowdin.com/project/rclone-manger) 或阅读 [翻译指南](CONTRIBUTING.md#adding-translations)。
- 🐛 **错误与功能:** 提交 [Issue](https://github.com/Zarestia-Dev/rclone-manager/issues) 或查看 [项目看板](https://github.com/users/Zarestia-Dev/projects/2)。
- 🔧 **代码更改:** 请在提交 Pull Request 之前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可证与支持

- **许可证:** 采用 [GNU GPLv3](LICENSE) 授权 – 免费使用、修改和分发。
- **支持:** 如果您喜欢这个项目，请考虑在 GitHub 上给它一个 ⭐！
- **捐款:** 如果 RClone Manager 节省了您的时间，请考虑[支持项目开发](https://hakanismail.info/zarestia/donate) ❤️

<p align="center">
  由 Zarestia 团队倾心制作<br>
  <sub>基于 Rclone | 使用 Angular & Tauri 构建</sub>
</p>
