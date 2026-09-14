<p align="center">
  <img src="assets/App Banner.png" alt="RClone Manager">
</p>

<h1 align="center">RClone Manager</h1>

<p align="center">
  <a href="README.md">🇺🇸 English</a> •
  <a href="README.tr-TR.md">🇹🇷 Türkçe</a> •
  <a href="README.zh-CN.md">🇨🇳 简体中文</a> •
  <a href="README.zh-TW.md">🇹🇼 繁體中文</a> •
  <a href="README.fr-FR.md">🇫🇷 Français</a> •
  <a href="README.es-ES.md">🇪🇸 Español</a> •
  <a href="README.pt-BR.md">🇧🇷 Português-Brasil</a> •
  <a href="README.ru-RU.md">🇷🇺 Русский</a> •
  <a href="README.ja-JP.md">🇯🇵 日本語</a> •
  <a href="CONTRIBUTING.md#adding-translations">協助翻譯</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>一個強大且跨平台的 GUI，讓您以優雅、輕鬆的方式管理 Rclone 雲端連接。</b><br>
  <i>使用 Angular 22 + Tauri 建置 · 支援 Linux • Windows • macOS • Android (測試版) • ARM</i>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs">
    <img src="https://img.shields.io/badge/📚_Documentation_Wiki-blue?style=flat-square" alt="Documentation">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat-square&color=2ec27e" alt="Latest Release">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/downloads/Zarestia-Dev/rclone-manager/total?style=flat-square&color=e66100" alt="下載量">
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

## 專案概述

**RClone Manager** 簡化了遠端檔案管理與同步。以 Rclone 為核心骨架，它提供了一個帶有內建檔案管理器（**Nautilus**）的桌面環境，讓您可以輕鬆傳輸、掛載和提供遠端檔案伺服服務。

- 📂 **Nautilus 檔案管理器:** 瀏覽、編輯、移動、複製、重新命名與刪除遠端檔案。
- 👁️ **檔案檢視器:** 影片、圖片、PDF、音訊與文字檔案的行內預覽。
- ⚡ **視覺化工作流程 (Visual Workflows):** 透過互動式節點畫布、Cron 排程器、資料夾監視器與即時警報通知，設計並自動化多步驟雲端管線。
- 🚀 **快速執行 (Quick Runs):** 從狀態感知的卡片網格中一鍵觸發雲端操作與自訂 CLI 參數預設。
- ⚙️ **掛載與伺服:** 簡易的掛載控制與伺服協定管理（WebDAV、SFTP、HTTP、FTP）。
- 🔄 **工作監視器:** 即時傳輸監控與頻寬控制。
- 🌐 **無周邊（Headless）模式:** 存取 [RClone Manager Headless](headless/README.md) 在 VPS/NAS 上作為 Web 伺服器執行！

---

## 介面截圖

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="RClone Manager Desktop UI" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 想了解更多？請造訪 <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Wiki 藝廊</a></b> 了解所有功能。</i>
</p>

---

## 安裝與下載

使用您偏好的套件管理器安裝 RClone Manager，或直接從 [版本發佈頁面](https://github.com/Zarestia-Dev/rclone-manager/releases) 下載獨立二進位檔。

### Linux

| 來源          | 版本                                                                                                                                                                                    | 安裝指令 / 下載                                                                                                     |
| :------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| **AUR**       | [![AUR 版本](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                      | `yay -S rclone-manager`                                                                                             |
| **AUR (Git)** | [![AUR 版本](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                              | `yay -S rclone-manager-git`                                                                                         |
| **Flathub**   | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager)     | `flatpak install io.github.zarestia_dev.rclone-manager`                                                             |
| **直接下載**  | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [最新版本 (.deb, .rpm, .AppImage, Portable tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **指南:** [Wiki: 安裝 - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux)（Flatpak 問題排查、Snap 等）

### macOS

| 來源         | 版本                                                                                                                                                                                                        | 安裝指令 / 下載                                                                                            |
| :----------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| **Homebrew** | [![Homebrew 版本](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew trust Zarestia-Dev/zarestia && brew install --cask rclone-manager` |
| **直接下載** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                     | [DMG 安裝檔](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                               |

> 📚 **指南:** [Wiki: 安裝 - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos)（macFUSE 與 Gatekeeper 設定）

### Windows

| 來源           | 版本                                                                                                                                                                                                           | 安裝指令 / 下載                                                                       |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| **Winget**     | [![Winget 版本](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                        |
| **Chocolatey** | [![Chocolatey 版本](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                              | `choco install rclone-manager`                                                        |
| **Scoop**      | [![Scoop 版本](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                   | `scoop bucket add extras && scoop install rclone-manager`                             |
| **直接下載**   | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                        | [安裝檔 / 可攜式 EXE](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **指南:** [Wiki: 安裝 - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows)（WinFsp 掛載需求與 SmartScreen）

### Android (測試版)

| 來源         | 版本                                                                                                                                                                                    | 安裝指令 / 下載                                                                                                  |
| :----------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| **直接下載** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [APK 下載 (arm64-v8a, armeabi-v7a, x86_64, x86)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **指南:** [Wiki: Android 支援 (測試版)](https://hakanismail.info/zarestia/rclone-manager/docs/configuration-android) (Go 引擎 / librclone 詳細資訊與設定)

> 🛠️ **系統需求:** 掛載磁碟機需要 WinFsp (Windows)、macFUSE (macOS) 或 FUSE3 (Linux)。如果缺失，Rclone 本身會自動下載。請參閱 [Wiki: 系統需求](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies)。

---

## 開發與支援

- **從原始碼建置:** 請參考 [建置指南](https://hakanismail.info/zarestia/rclone-manager/docs/building)。
- **程式碼品質:** 造訪 [LINTING.md](LINTING.md) 獲取樣式指南。
- **問題排查:** 造訪我們的 [問題排查 Wiki](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) 或閱讀 [ISSUES.md](ISSUES.md) 以取得平台專屬說明。

---

## 參與貢獻

我們熱烈歡迎任何形式的貢獻！

- 🌍 **翻譯:** 加入 [Crowdin 專案](https://crowdin.com/project/rclone-manger) 或閱讀 [翻譯指南](CONTRIBUTING.md#adding-translations)。
- 🐛 **錯誤與功能建議:** 提交 [Issue](https://github.com/Zarestia-Dev/rclone-manager/issues) 或查看 [專案看板](https://github.com/users/Zarestia-Dev/projects/2)。
- 🔧 **程式碼變更:** 請在提交 Pull Request 之前閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 授權條款與支援

- **授權條款:** 採用 [GNU GPLv3](LICENSE) 授權 – 免費使用、修改與散布。
- **支援:** 如果您喜歡這個專案，請考慮在 GitHub 上給它一顆 ⭐！

<p align="center">
  由 Zarestia 團隊傾心製作<br>
  <sub>基於 Rclone | 使用 Angular & Tauri 建置</sub>
</p>
