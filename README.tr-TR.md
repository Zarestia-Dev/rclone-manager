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
  <a href="CONTRIBUTING.md#adding-translations">Çeviriye Yardım Edin</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>Rclone uzak bağlantılarını stil ve kolaylıkla yönetmek için güçlü, çapraz platform bir GUI.</b><br>
  <i>Angular 22 + Tauri ile yapıldı · Linux • Windows • macOS • ARM Desteği</i>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs">
    <img src="https://img.shields.io/badge/📚_Dökümantasyon_Wiki-blue?style=flat-square" alt="Dökümantasyon">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat-square&color=2ec27e" alt="Son Sürüm">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/Zarestia-Dev/rclone-manager?style=flat-square&color=9141ac" alt="Lisans">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/stargazers">
    <img src="https://img.shields.io/github/stars/Zarestia-Dev/rclone-manager?style=flat-square&color=3584e4" alt="Yıldızlar">
  </a>
  <a href="https://crowdin.com/project/rclone-manger">
    <img src="https://badges.crowdin.net/rclone-manger/localized.svg?style=flat-square" alt="Crowdin Durumu">
  </a>
  <a href="https://hakanismail.info/zarestia/support">
    <img src="https://img.shields.io/badge/Donate-ea4aaa?style=flat-square" alt="Donate">
  </a>
</p>

---

## Genel Bakış

**RClone Manager**, uzak dosya yönetimini ve senkronizasyonunu basitleştirir. Rclone'u temel alarak, uzak dosyaları zahmetsizce aktarmak, bağlamak ve sunmak için yerleşik bir dosya yöneticisi (**Nautilus**) içeren bir masaüstü ortamı sunar.

- 📂 **Nautilus Dosya Yöneticisi:** Uzak dosyaları tarayın, düzenleyin, taşıyın, kopyalayın, yeniden adlandırın ve silin.
- 👁️ **Dosya Görüntüleyici:** Videolar, resimler, PDF'ler, ses ve metinler için yerleşik önizlemeler.
- ⚙️ **Bağlama ve Sunma:** Kolay bağlama kontrolleri ve sunma yönetimi (WebDAV, SFTP, HTTP, FTP).
- 🔄 **Görev İzleyici:** Gerçek zamanlı aktarım izleme ve bant genişliği kontrolü.
- 🌐 **Headless Modu:** VPS/NAS sunucularında GUI olmadan bir web sunucusu olarak çalıştırmak için [RClone Manager Headless](headless/README.md) sürümüne göz atın!

---

## Ekran Görüntüsü

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="RClone Manager Masaüstü UI" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 Daha fazla görmek ister misiniz? Tüm özellikler için <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Wiki Galeri</a></b> sayfasına göz atın.</i>
</p>

---

## Kurulum ve İndirmeler

RClone Manager'ı tercih ettiğiniz paket yöneticisini kullanarak yükleyin veya doğrudan [Sürümler](https://github.com/Zarestia-Dev/rclone-manager/releases) sayfasından indirin.

### Linux

| Kaynak               | Sürüm                                                                                                                                                                               | Kurulum Komutu / İndirme                                                                                                |
| :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| **AUR**              | [![AUR Sürümü](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                | `yay -S rclone-manager`                                                                                                 |
| **AUR (Git)**        | [![AUR Sürümü](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                        | `yay -S rclone-manager-git`                                                                                             |
| **Flathub**          | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager) | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                 |
| **Doğrudan İndirme** | [![Son Sürüm](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)  | [Son Sürümler (.deb, .rpm, .AppImage, Portable tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Kılavuz:** [Wiki: Kurulum - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) (Flatpak sorun giderme vb.)

### macOS

| Kaynak               | Sürüm                                                                                                                                                                                                         | Kurulum Komutu / İndirme                                                        |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------ |
| **Homebrew**         | [![Homebrew Sürümü](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew install --cask rclone-manager`          |
| **Doğrudan İndirme** | [![Son Sürüm](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                            | [DMG Yükleyici](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Kılavuz:** [Wiki: Kurulum - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) (macFUSE & Gatekeeper düzeltmeleri)

### Windows

| Kaynak               | Sürüm                                                                                                                                                                                                            | Kurulum Komutu / İndirme                                                                      |
| :------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| **Winget**           | [![Winget Sürümü](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                                |
| **Chocolatey**       | [![Chocolatey Sürümü](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                              | `choco install rclone-manager`                                                                |
| **Scoop**            | [![Scoop Sürümü](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                   | `scoop bucket add extras && scoop install rclone-manager`                                     |
| **Doğrudan İndirme** | [![Son Sürüm](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                               | [Yükleyici / Taşınabilir EXE](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Kılavuz:** [Wiki: Kurulum - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) (WinFsp bağlama gereksinimleri & SmartScreen)

> 🛠️ **Sistem Gereksinimleri:** Sürücüleri bağlamak WinFsp (Windows), macFUSE (macOS) veya FUSE3 (Linux) gerektirir. Rclone eksikse otomatik olarak indirilir. Bkz. [Wiki: Sistem Gereksinimleri](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies).

---

## Geliştirme ve Destek

- **Kaynaktan Derleme:** [Derleme Kılavuzu](https://hakanismail.info/zarestia/rclone-manager/docs/building) sayfasına bakın.
- **Kod Kalitesi:** Tarz kuralları için [LINTING.md](LINTING.md) dosyasına bakın.
- **Sorun Giderme:** [Sorun Giderme Wiki](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) sayfamızı ziyaret edin veya platforma özel notlar için [ISSUES.md](ISSUES.md) dosyasını okuyun.

---

## Katkıda Bulunma

Her türlü katkıyı memnuniyetle karşılıyoruz!

- 🌍 **Çeviriler:** [Crowdin Projesi](https://crowdin.com/project/rclone-manger)'ne katılın veya [Çeviri Kılavuzu](CONTRIBUTING.md#adding-translations)'nu okuyun.
- 🐛 **Hatalar & Özellikler:** Bir [Sorun (Issue)](https://github.com/Zarestia-Dev/rclone-manager/issues) açın veya [Proje Panosu](https://github.com/users/Zarestia-Dev/projects/2)'nu kontrol edin.
- 🔧 **Kod Değişiklikleri:** Pull Request göndermeden önce lütfen [CONTRIBUTING.md](CONTRIBUTING.md) dosyasını okuyun.

---

## Lisans ve Destek

- **Lisans:** [GNU GPLv3](LICENSE) altında lisanslanmıştır – kullanmak, değiştirmek ve dağıtmak serbesttir.
- **Destek:** Bu projeyi beğendiyseniz, lütfen GitHub üzerinde bir ⭐ bırakmayı düşünün!
- **Bağış:** RClone Manager size zaman kazandırıyorsa, [geliştirmeyi desteklemeyi](https://hakanismail.info/zarestia/support) düşünün ❤️

<p align="center">
  Zarestia Dev Ekibi tarafından ❤️ ile yapıldı<br>
  <sub>Rclone ile Desteklenmektedir | Angular & Tauri ile Yapılmıştır</sub>
</p>
