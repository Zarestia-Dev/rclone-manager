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
  <a href="README.ru-RU.md">🇷🇺 Русский</a> •
  <a href="CONTRIBUTING.md#adding-translations">翻訳に参加する</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>スタイリッシュかつ簡単に Rclone リモートを管理できる強力なクロスプラットフォーム GUI</b><br>
  <i>Angular 22 + Tauri で構築 · Linux • Windows • macOS • ARM 対応</i>
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
  <a href="https://hakanismail.info/zarestia/support">
    <img src="https://img.shields.io/badge/Donate-ea4aaa?style=flat-square" alt="Donate">
  </a>
</p>

---

## 概要

**RClone Manager** は、リモートファイルの管理と同期をシンプルにします。Rclone をコアとして採用し、組み込みファイルマネージャー（**Nautilus**）を備えたデスクトップ環境を提供することで、リモートファイルの転送・マウント・公開の手間なく直感的に行えます。

- 📂 **Nautilus ファイルマネージャー:** リモートファイルの閲覧、編集、移動、コピー、名前変更、削除が可能です。
- 👁️ **ファイルビューアー:** 動画、画像、PDF、音声、テキストファイルのインラインプレビューに対応しています。
- ⚙️ **マウント & 公開:** 簡単なマウント操作と公開（WebDAV、SFTP、HTTP、FTP）の管理が行えます。
- 🔄 **ジョブウォッチャー:** 転送のリアルタイムモニタリングと帯域幅制御が可能です。
- 🌐 **ヘッドレスモード:** VPS や NAS 上で Web サーバーとして実行したい場合は [RClone Manager Headless](headless/README.md) をご覧ください！

---

## スクリーンショット

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="RClone Manager Desktop UI" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 さらに詳しい機能を見たい場合は、<b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Wiki ギャラリー</a></b> をご覧ください。</i>
</p>

---

## インストール & ダウンロード

お好みのパッケージマネージャーを使用してインストールするか、[リリースページ](https://github.com/Zarestia-Dev/rclone-manager/releases) からスタンドアロンのバイナリを直接ダウンロードしてください。

### Linux

| 取得元              | バージョン                                                                                                                                                                               | インストールコマンド / ダウンロード                                                                                           |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **AUR**             | [![AUR Version](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                   | `yay -S rclone-manager`                                                                                                    |
| **AUR (Git)**       | [![AUR Version](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                           | `yay -S rclone-manager-git`                                                                                                |
| **Flathub**         | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager)     | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                    |
| **直接ダウンロード** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [最新リリース (.deb, .rpm, .AppImage, ポータブル tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **ガイド:** [Wiki: インストール - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) (Flatpak トラブルシューティング、スナップショットなど)

### macOS

| 取得元              | バージョン                                                                                                                                                                                                    | インストールコマンド / ダウンロード                                              |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| **Homebrew**        | [![Homebrew Version](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew trust zarestia-dev/zarestia && brew install --cask rclone-manager`          |
| **直接ダウンロード** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                        | [DMG インストーラー](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **ガイド:** [Wiki: インストール - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) (macFUSE および Gatekeeper の修正)

### Windows

| 取得元              | バージョン                                                                                                                                                                                                       | インストールコマンド / ダウンロード                                                         |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **Winget**          | [![Winget Version](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                             |
| **Chocolatey**      | [![Chocolatey Version](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                              | `choco install rclone-manager`                                                             |
| **Scoop**           | [![Scoop Version](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                   | `scoop bucket add extras && scoop install rclone-manager`                                  |
| **直接ダウンロード** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                           | [インストーラー / ポータブル EXE](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **ガイド:** [Wiki: インストール - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) (WinFsp マウント要件および SmartScreen 対策)

> 🛠️ **システム要件:** ドライブをマウントするには WinFsp (Windows)、macFUSE (macOS)、または FUSE3 (Linux) が必要です。Rclone 自体は未導入の場合に自動ダウンロードされます。[Wiki: システム要件](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies) を参照してください。

---

## 開発 & サポート

- **ソースからのビルド:** [ビルドガイド](https://hakanismail.info/zarestia/rclone-manager/docs/building) を参照してください。
- **コード品質:** スタイルガイドラインについては [LINTING.md](LINTING.md) をご確認ください。
- **トラブルシューティング:** [トラブルシューティング Wiki](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) をご覧いただくか、OS 固有の注意事項について [ISSUES.md](ISSUES.md) をお読みください。

---

## 貢献

あらゆる形式での貢献を歓迎します！

- 🌍 **翻訳:** [Crowdin プロジェクト](https://crowdin.com/project/rclone-manger) に参加するか、[翻訳ガイド](CONTRIBUTING.md#adding-translations) をご覧ください。
- 🐛 **バグ & 機能リクエスト:** [Issue](https://github.com/Zarestia-Dev/rclone-manager/issues) を作成するか、[プロジェクトボード](https://github.com/users/Zarestia-Dev/projects/2) を確認してください。
- 🔧 **コードの変更:** プルリクエストを送信する前に [CONTRIBUTING.md](CONTRIBUTING.md) をご確認ください。

---

## ライセンス & サポート

- **ライセンス:** [GNU GPLv3](LICENSE) の下でライセンスされています – 使用、変更、配布が自由に行えます。
- **サポート:** このプロジェクトを気に入っていただけましたら、ぜひ GitHub で ⭐ をご検討ください！
- **寄付:** RClone Manager がお役に立ちましたら、[開発の支援](https://hakanismail.info/zarestia/support) をご検討いただけると幸いです ❤️

<p align="center">
  Zarestia Dev Team が ❤️ を込めて開発<br>
  <sub>Rclone 搭載 | Angular & Tauri で構築</sub>
</p>
