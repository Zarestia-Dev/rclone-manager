<p align="center">
  <img src="assets/App Banner.png" alt="RClone Manager">
</p>

<h1 align="center">
  RClone Manager
</h1>

<p align="center">
  <a href="README.md">🇺🇸 English</a> •
  <a href="README.tr-TR.md">🇹🇷 Türkçe</a> •
  <a href="soon">Çeviriye Yardım Edin</a>
</p>

<p align="center">
  <b>Rclone uzak bağlantılarını stil ve kolaylıkla yönetmek için güçlü, çapraz platform bir GUI.</b><br>
  <i>Angular 20 + Tauri ile yapıldı · Linux • Windows • macOS • ARM Desteği</i>
</p>

<p align="center">
  <a href="https://github.com/Zarestia-Dev/rclone-manager/wiki">
    <img src="https://img.shields.io/badge/📚_Dökümantasyon_Wiki-blue?style=for-the-badge" alt="Dökümantasyon">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=for-the-badge&color=2ec27e" alt="Son Sürüm">
  </a>
</p>

<p align="center">
  <a href="https://github.com/Zarestia-Dev/rclone-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/Zarestia-Dev/rclone-manager?style=flat&color=9141ac" alt="Lisans">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/stargazers">
    <img src="https://img.shields.io/github/stars/Zarestia-Dev/rclone-manager?style=flat&color=3584e4" alt="Yıldızlar">
  </a>
</p>

---

## Genel Bakış

**RClone Manager**, [Rclone](https://rclone.org/) uzak bağlantılarını yönetmeyi zahmetsiz hale getiren **modern, çapraz platform bir GUI**'dir. Bulut depolama sağlayıcıları arasında dosya senkronizasyonu, uzak sürücüleri bağlama veya karmaşık dosya işlemleri gerçekleştirme olsun, RClone Manager en gelişmiş Rclone özelliklerini bile basitleştiren sezgisel bir arayüz sunar.

<div align="center">

> ### 🌐 **Headless Modu mu Arıyorsunuz?**
>
> **[RClone Manager Headless](headless/README.md)** – GUI olmadan Linux sunucularında web sunucusu olarak çalıştırın!  
> NAS, VPS ve uzak sistemler için mükemmel. Herhangi bir tarayıcıdan erişin. 🚀

</div>

> Yeni özellikler ve iyileştirmelerle düzenli güncellemeler. Sırada ne olduğunu görmek için [yol haritamıza](https://github.com/users/Zarestia-Dev/projects/2) göz atın!

---

## 📸 Ekran Görüntüleri

<p align="center">
  <img src="assets/desktop-ui.png" alt="Masaüstü UI" width="40%">
</p>
<p align="center">

|                               Ana Sayfa                                |                          Uzak Bağlantı Genel Bakış                           |                             Bağlama Kontrolü                             |
| :--------------------------------------------------------------------: | :--------------------------------------------------------------------------: | :----------------------------------------------------------------------: |
| <img src="assets/general-home.png" alt="Genel Ana Sayfa" width="250"/> | <img src="assets/general-remote.png" alt="Genel Uzak Bağlantı" width="250"/> | <img src="assets/mount-control.png" alt="Bağlama Kontrolü" width="250"/> |

|                            Görev İzleyici                            |                             Sunma Kontrolü                             |                          Karanlık Mod                          |
| :------------------------------------------------------------------: | :--------------------------------------------------------------------: | :------------------------------------------------------------: |
| <img src="assets/job-watcher.png" alt="Görev İzleyici" width="250"/> | <img src="assets/serve-control.png" alt="Sunma Kontrolü" width="250"/> | <img src="assets/dark-ui.png" alt="Karanlık Mod" width="250"/> |

</p>

---

## 📦 İndirmeler

Favori paket yöneticinizden yükleyin veya doğrudan indirin.

### Linux

| Depo                 | Sürüm                                                                                                                                                                                  | Kurulum Komutu                                                                                                                                                        |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUR**              | [![AUR Sürümü](https://img.shields.io/aur/version/rclone-manager?style=flat&label=)](https://aur.archlinux.org/packages/rclone-manager)                                                | `yay -S rclone-manager`                                                                                                                                               |
| **AUR (Git)**        | [![AUR Sürümü](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=)](https://aur.archlinux.org/packages/rclone-manager-git)                                        | `yay -S rclone-manager-git`                                                                                                                                           |
| **Flathub**          | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/en/apps/io.github.zarestia_dev.rclone-manager) | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                                                               |
| **Doğrudan İndirme** | [![Son Sürüm](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)     | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/latest"><img src="https://img.shields.io/badge/İndir-3584e4?style=flat&logo=github" alt="İndir"></a> |

> 📚 **Detaylı Kılavuz:** [Wiki: Kurulum - Linux](https://github.com/Zarestia-Dev/rclone-manager/wiki/Installation-Linux)  
> _Flatpak için sorun giderme içerir._

### macOS

| Depo                 | Sürüm                                                                                                                                                                              | Kurulum Komutu                                                                                                                                                        |
| :------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Homebrew**         | ![Beklemede](https://img.shields.io/badge/Beklemede-gray?style=flat)                                                                                                               | _Yakında_                                                                                                                                                             |
| **Doğrudan İndirme** | [![Son Sürüm](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/latest"><img src="https://img.shields.io/badge/İndir-3584e4?style=flat&logo=github" alt="İndir"></a> |

> 📚 **Detaylı Kılavuz:** [Wiki: Kurulum - macOS](https://github.com/Zarestia-Dev/rclone-manager/wiki/Installation-macOS)  
> _Önemli: "Uygulama Hasarlı" düzeltmesi ve macFUSE kurulumu için bunu okuyun._

### Windows

| Depo                 | Sürüm                                                                                                                                                                                   | Kurulum Komutu                                                                                                                                                        |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chocolatey**       | [![Chocolatey](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                            | `choco install rclone-manager`                                                                                                                                        |
| **Scoop**            | [![Scoop](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json) | `scoop bucket add extras` sonra `scoop install rclone-manager`                                                                                                        |
| **Winget**           | ![Winget](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)                                                                                 | `winget install RClone-Manager.rclone-manager`                                                                                                                        |
| **Doğrudan İndirme** | [![Son Sürüm](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)      | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/latest"><img src="https://img.shields.io/badge/İndir-3584e4?style=flat&logo=github" alt="İndir"></a> |

> 📚 **Detaylı Kılavuz:** [Wiki: Kurulum - Windows](https://github.com/Zarestia-Dev/rclone-manager/wiki/Installation-Windows)  
> _WinFsp (bağlama için gerekli) ve SmartScreen talimatlarını içerir._

---

## 🛠️ Sistem Gereksinimleri

RClone Manager çoğu bağımlılığı otomatik olarak yönetir.

- **Rclone:** Eksikse uygulama sizin için indirecektir.
- **Bağlama (İsteğe Bağlı):** **WinFsp** (Windows), **macFUSE** (macOS) veya **FUSE3** (Linux) gerektirir.
- **Detaylar:** Tam uyumluluk notları için **[Wiki: Sistem Gereksinimleri](https://github.com/Zarestia-Dev/rclone-manager/wiki/Installation#%EF%B8%8F-dependencies)** sayfasına bakın.

---

## 🛠️ Geliştirme

Kaynaktan derleme (Masaüstü, Headless, Docker veya Flatpak) için lütfen **[Derleme Kılavuzu](https://github.com/Zarestia-Dev/rclone-manager/wiki/Building)**'na bakın.

### Linting & Formatlama

- Kod kalitesini koruma talimatları için [**LINTING.md**](LINTING.md) dosyasına bakın.

---

## 🐞 Sorun Giderme

Bir sorunla mı karşılaştınız?

1.  Yaygın düzeltmeler için **[Sorun Giderme Wiki](https://github.com/Zarestia-Dev/rclone-manager/wiki/Troubleshooting)** sayfasına bakın (Bağlama hataları, İzinler, Uygulama Başlatma sorunları).
2.  Platform özel bilinen sınırlamalar için [**ISSUES.md**](ISSUES.md) dosyasına bakın.
3.  Üzerinde çalıştığımız şeyleri görmek için **[GitHub Proje Panosu](https://github.com/users/Zarestia-Dev/projects/2)**'nu ziyaret edin.

---

## 🤝 Katkıda Bulunma

Katkıları memnuniyetle karşılıyoruz! İşte nasıl yardım edebilirsiniz:

- 🌍 **Çevirmeye Yardım Edin** – Yakında....
- 🐛 **Hata Bildirin** – [Hata raporu açın](https://github.com/Zarestia-Dev/rclone-manager/issues/new?template=bug_report.md)
- 💡 **Özellik Önerin** – [Fikirlerinizi paylaşın](https://github.com/Zarestia-Dev/rclone-manager/issues/new?template=feature_request.md)
- 📖 **Belgeleri İyileştirin** – [Dökümantasyonumuzu](https://github.com/Zarestia-Dev/rclone-manager/wiki) daha net hale getirmemize yardımcı olun
- 🔧 **PR Gönderin** – [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın
- 💬 **Tartışın** – [GitHub Tartışmalarına](https://github.com/Zarestia-Dev/rclone-manager/discussions) katılın

---

## 📜 Lisans

**[GNU GPLv3](LICENSE)** altında lisanslanmıştır – kullanmak, değiştirmek ve dağıtmak serbesttir.

---

## ⭐ Projeyi Destekleyin

- Sürümlerden haberdar olmak için repo'yu **Yıldızlayın** ve **İzleyin**
- Arkadaşlarınızla paylaşın!

---

<p align="center">
  Zarestia Dev Ekibi tarafından ❤️ ile yapıldı<br>
  <sub>Rclone ile Desteklenmektedir | Angular & Tauri ile Yapılmıştır</sub>
</p>
