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
  <a href="README.sk-SK.md">🇸🇰 Slovenčina</a> •
  <a href="CONTRIBUTING.md#adding-translations">Pomôžte s prekladom</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>Výkonné multiplatformové grafické rozhranie na štýlovú a jednoduchú správu vzdialených úložísk Rclone.</b><br>
  <i>Postavené na Angular 22 + Tauri · Linux • Windows • macOS • Android (Beta) • podpora ARM</i>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/architecture">
    <img src="https://img.shields.io/badge/Architecture-Specification-blueviolet?style=for-the-badge" alt="Architecture Specification">
  </a>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs">
    <img src="https://img.shields.io/badge/📚_Documentation_Wiki-blue?style=flat-square" alt="Documentation">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat-square&color=2ec27e" alt="Latest Release">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/downloads/Zarestia-Dev/rclone-manager/total?style=flat-square&color=e66100" alt="Downloads">
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

## Prehľad

**RClone Manager** zjednodušuje správu a synchronizáciu súborov vo vzdialených úložiskách. Ako základ využíva Rclone a ponúka desktopové prostredie so vstavaným správcom súborov (**Nautilus**), v ktorom môžete súbory zo vzdialených úložísk bez námahy prenášať, pripájať a sprístupňovať.

- 📂 **Správca súborov Nautilus:** Prehliadajte, upravujte, presúvajte, kopírujte, premenúvajte a odstraňujte súbory vo vzdialených úložiskách.
- 👁️ **Prehliadač súborov:** Vstavaný náhľad videí, obrázkov, PDF, zvuku a textu.
- ⚡ **Vizuálne pracovné postupy:** Navrhujte a automatizujte viacstupňové cloudové postupy na interaktívnom plátne s uzlami, so spúšťačmi cron, sledovaním priečinkov a okamžitými upozorneniami.
- 🚀 **Rýchle spustenia:** Spúšťajte cloudové operácie a vlastné predvoľby prepínačov CLI jedným kliknutím priamo z mriežky kariet so zobrazením stavu.
- ⚙️ **Pripojenie a servery:** Jednoduché ovládanie pripojení a správa serverov (WebDAV, SFTP, HTTP, FTP).
- 🔄 **Sledovanie úloh:** Sledovanie prenosov v reálnom čase a riadenie šírky pásma.
- 📱 **Android SAF a DocumentsProvider:** Natívny prístup k cloudovým úložiskám v systémových výberoch súborov cez Storage Access Framework a interný most pripojenia VFS bez root.
- 🌐 **Režim bez GUI (headless):** Spúšťajte na VPS/NAS pomocou [RClone Manager Server](backend/server/README.md). Dokumentácia servera a šablóna služby pre Linux sa nachádzajú v `backend/server/`.

---

## Snímky obrazovky

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="RClone Manager - Dashboard" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <sub>Prehľad – rýchle spustenia, pripojenia a prehľad vzdialených úložísk na prvý pohľad</sub>
</p>

<p align="center">
  <img alt="RClone Manager - Workflow Builder" src="assets/workflow-builder.png" width="90%">
  <br>
  <sub>Tvorba pracovných postupov – navrhujte a automatizujte viacstupňové cloudové postupy na interaktívnom plátne s uzlami</sub>
</p>

<p align="center">
  <img alt="RClone Manager - Nautilus File Manager" src="assets/nautilus.png" width="90%">
  <br>
  <sub>Nautilus – prehliadajte, prenášajte a spravujte súbory vo všetkých vzdialených úložiskách</sub>
</p>

<p align="center">
  <i>📖 Chcete vidieť viac? Všetky funkcie nájdete v <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">galérii na wiki</a></b>.</i>
</p>

---

## Inštalácia a stiahnutie

Nainštalujte RClone Manager pomocou preferovaného správcu balíkov alebo si stiahnite samostatné binárne súbory priamo zo stránky [Releases](https://github.com/Zarestia-Dev/rclone-manager/releases).

### Linux

| Zdroj                 | Verzia                                                                                                                                                                                  | Príkaz na inštaláciu / stiahnutie                                                                                            |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **AUR**               | [![AUR Version](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                   | `yay -S rclone-manager`                                                                                                      |
| **AUR (Git)**         | [![AUR Version](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                           | `yay -S rclone-manager-git`                                                                                                  |
| **Flathub**           | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager)     | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                      |
| **Priame stiahnutie** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [Najnovšie vydania (.deb, .rpm, .AppImage, prenosný tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Návod:** [Wiki: Inštalácia – Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) (riešenie problémov s Flatpakom, snapshotmi atď.)

### macOS

| Zdroj                 | Verzia                                                                                                                                                                                                         | Príkaz na inštaláciu / stiahnutie                                                                          |
| :-------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| **Homebrew**          | [![Homebrew Version](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew trust zarestia-dev/zarestia && brew install --cask rclone-manager` |
| **Priame stiahnutie** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                        | [Inštalátor DMG](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                           |

> 📚 **Návod:** [Wiki: Inštalácia – macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) (riešenia pre macFUSE a Gatekeeper)

### Windows

| Zdroj                 | Verzia                                                                                                                                                                                                            | Príkaz na inštaláciu / stiahnutie                                                           |
| :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **Winget**            | [![Winget Version](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                              |
| **Chocolatey**        | [![Chocolatey Version](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                              | `choco install rclone-manager`                                                              |
| **Scoop**             | [![Scoop Version](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                   | `scoop bucket add extras && scoop install rclone-manager`                                   |
| **Priame stiahnutie** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                           | [Inštalátor / prenosný EXE](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Návod:** [Wiki: Inštalácia – Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) (požiadavky WinFsp na pripájanie a SmartScreen)

### Android (Beta)

| Zdroj                 | Verzia                                                                                                                                                                                  | Príkaz na inštaláciu / stiahnutie                                                                                      |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **Priame stiahnutie** | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [Stiahnutie APK (arm64-v8a, armeabi-v7a, x86_64, x86)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📱 **Storage Access Framework (SAF):** Obsahuje natívnu integráciu `DocumentsProvider` (`RcloneDocumentsProvider`) a interný most pripojenia VFS, ktoré sprístupňujú pripojené cloudové úložiská priamo systémovým výberom súborov v Androide a externým aplikáciám bez potreby root alebo `/dev/fuse`.
>
> 📚 **Návod:** [Wiki: Podpora Androidu (Beta)](https://hakanismail.info/zarestia/rclone-manager/docs/configuration-android) (podrobnosti o jadre Go / librclone, poskytovateľ SAF a nastavenie)

> 🛠️ **Systémové požiadavky:** Pripájanie jednotiek vyžaduje WinFsp (Windows), macFUSE (macOS) alebo FUSE3 (Linux). Samotný Rclone sa v prípade potreby stiahne automaticky. Pozri [Wiki: Systémové požiadavky](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies).

---

## Vývoj a podpora

- **Zostavenie zo zdrojového kódu:** Pozri [návod na zostavenie](https://hakanismail.info/zarestia/rclone-manager/docs/building).
- **Kvalita kódu:** Pravidlá štýlu nájdete v [LINTING.md](LINTING.md).
- **Riešenie problémov:** Navštívte [wiki o riešení problémov](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) alebo si prečítajte [ISSUES.md](ISSUES.md) s poznámkami pre jednotlivé platformy.

---

## Prispievanie

Vítame príspevky všetkých druhov!

- 🌍 **Preklady:** Pridajte sa k [projektu na Crowdin](https://crowdin.com/project/rclone-manger) alebo si prečítajte [návod na preklad](CONTRIBUTING.md#adding-translations).
- 🐛 **Chyby a funkcie:** Založte [issue](https://github.com/Zarestia-Dev/rclone-manager/issues) alebo si pozrite [tabuľu projektu](https://github.com/users/Zarestia-Dev/projects/2).
- 🔧 **Zmeny kódu:** Pred odoslaním pull requestu si prečítajte [CONTRIBUTING.md](CONTRIBUTING.md).
- 👥 **Prispievatelia:** V [CONTRIBUTORS.md](CONTRIBUTORS.md) nájdete všetkých, ktorí pomohli vytvoriť RClone Manager.

---

## Licencia a podpora

- **Licencia:** Šírené pod licenciou [GNU GPLv3](LICENSE) – môžete ho voľne používať, upravovať a šíriť.
- **Podpora:** Ak sa vám projekt páči, zvážte udelenie ⭐ na GitHube!

<p align="center">
  Vytvoril s ❤️ tím Zarestia Dev<br>
  <sub>Poháňané Rclone | Postavené na Angular a Tauri</sub>
</p>
