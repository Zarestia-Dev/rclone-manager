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
  <a href="CONTRIBUTING.md#adding-translations">Aider à traduire</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>Une interface graphique puissante et multiplateforme pour gérer les remotes Rclone avec style et simplicité.</b><br>
  <i>Conçu avec Angular 22 + Tauri · Support Linux • Windows • macOS • ARM</i>
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

## Présentation générale

**RClone Manager** simplifie la gestion et la synchronisation des fichiers distants. En utilisant Rclone comme colonne vertébrale, il offre un environnement de bureau avec un gestionnaire de fichiers intégré (**Nautilus**) pour transférer, monter et diffuser des fichiers distants sans effort.

- 📂 **Gestionnaire de fichiers Nautilus:** Parcourez, modifiez, déplacez, copiez, renommez et supprimez des fichiers distants.
- 👁️ **Visionneuse de fichiers:** Aperçus intégrés pour les vidéos, images, PDF, fichiers audio et textes.
- ⚙️ **Montage & Diffusion:** Contrôles de montage simples et gestion des serveurs de diffusion (WebDAV, SFTP, HTTP, FTP).
- 🔄 **Suivi des tâches:** Surveillance des transferts en temps réel et contrôle de la bande passante.
- 🌐 **Mode Headless (Sans tête):** Consultez [RClone Manager Headless](headless/README.md) pour l'exécuter en tant que serveur web sur VPS/NAS !

---

## Capture d'écran

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="Interface graphique RClone Manager" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 Vous voulez en voir plus ? Découvrez la <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Galerie Wiki</a></b> pour toutes les fonctionnalités.</i>
</p>

---

## Installation & Téléchargements

Installez RClone Manager à l'aide de votre gestionnaire de paquets préféré, ou téléchargez des exécutables autonomes directement depuis la page des [Versions](https://github.com/Zarestia-Dev/rclone-manager/releases).

### Linux

| Source                    | Version                                                                                                                                                                                   | Commande d'installation / Téléchargement                                                                                      |
| :------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| **AUR**                   | [![Version AUR](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                     | `yay -S rclone-manager`                                                                                                       |
| **AUR (Git)**             | [![Version AUR](https://img.shields.io/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                                 | `yay -S rclone-manager-git`                                                                                                   |
| **Flathub**               | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager)       | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                       |
| **Téléchargement direct** | [![Dernière version](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [Dernières versions (.deb, .rpm, .AppImage, Portable tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guide:** [Wiki: Installation - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) (résolution des problèmes Flatpak, snapshots, etc.)

### macOS

| Source                    | Version                                                                                                                                                                                                        | Commande d'installation / Téléchargement                                           |
| :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| **Homebrew**              | [![Version Homebrew](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew trust Zarestia-Dev/zarestia && brew install --cask rclone-manager`             |
| **Téléchargement direct** | [![Dernière version](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                      | [Installateur DMG](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guide:** [Wiki: Installation - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) (correctifs macFUSE & Gatekeeper)

### Windows

| Source                    | Version                                                                                                                                                                                                           | Commande d'installation / Téléchargement                                                      |
| :------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| **Winget**                | [![Version Winget](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                                |
| **Chocolatey**            | [![Version Chocolatey](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                              | `choco install rclone-manager`                                                                |
| **Scoop**                 | [![Version Scoop](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                   | `scoop bucket add extras && scoop install rclone-manager`                                     |
| **Téléchargement direct** | [![Dernière version](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                         | [Installateur / EXE Portable](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guide:** [Wiki: Installation - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) (conditions de montage WinFsp & SmartScreen)

> 🛠️ **Configuration système requise:** Le montage de disques requiert WinFsp (Windows), macFUSE (macOS) ou FUSE3 (Linux). Rclone lui-même est téléchargé automatiquement s'il est manquant. Voir [Wiki: Configuration système requise](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies).

---

## Développement & Support

- **Compilation depuis les sources:** Référez-vous au [Guide de compilation](https://hakanismail.info/zarestia/rclone-manager/docs/building).
- **Qualité du code:** Consultez [LINTING.md](LINTING.md) pour les directives de style.
- **Dépannage:** Visitez notre [Wiki de dépannage](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) ou lisez [ISSUES.md](ISSUES.md) pour des notes spécifiques aux plateformes.

---

## Contribution

Les contributions sous toutes leurs formes sont les bienvenues !

- 🌍 **Traductions:** Rejoignez le [Projet Crowdin](https://crowdin.com/project/rclone-manger) ou lisez le [Guide de traduction](CONTRIBUTING.md#adding-translations).
- 🐛 **Bugs & Fonctionnalités:** Ouvrez un [ticket](https://github.com/Zarestia-Dev/rclone-manager/issues) ou consultez le [Tableau de projet](https://github.com/users/Zarestia-Dev/projects/2).
- 🔧 **Modifications du code:** Veuillez lire [CONTRIBUTING.md](CONTRIBUTING.md) avant de soumettre une Pull Request.

---

## Licence & Support

- **Licence:** Publié sous licence [GNU GPLv3](LICENSE) – libre d'utilisation, de modification et de distribution.
- **Soutien:** Si vous appréciez ce projet, merci de laisser une ⭐ sur GitHub !
- **Don:** Si RClone Manager vous fait gagner du temps, pensez à [soutenir le développement](https://hakanismail.info/zarestia/support) ❤️

<p align="center">
  Fait avec ❤️ par l'équipe de développement Zarestia<br>
  <sub>Propulsé par Rclone | Développé avec Angular & Tauri</sub>
</p>
