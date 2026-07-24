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
  <a href="CONTRIBUTING.md#adding-translations">Помочь с переводом</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>Мощный кроссплатформенный графический интерфейс для удобного управления удалёнными хранилищами Rclone.</b><br>
  <i>Создан с использованием Angular 22 и Tauri · Linux • Windows • macOS • Поддержка ARM</i>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs">
    <img src="https://img.shields.io/badge/📚_Документация_Wiki-blue?style=flat-square" alt="Документация">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat-square&color=2ec27e" alt="Последний выпуск">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/Zarestia-Dev/rclone-manager?style=flat-square&color=9141ac" alt="Лицензия">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/stargazers">
    <img src="https://img.shields.io/github/stars/Zarestia-Dev/rclone-manager?style=flat-square&color=3584e4" alt="Звёзды">
  </a>
  <a href="https://crowdin.com/project/rclone-manger">
    <img src="https://badges.crowdin.net/rclone-manger/localized.svg?style=flat-square" alt="Состояние перевода Crowdin">
  </a>
  <a href="https://hakanismail.info/zarestia/support">
    <img src="https://img.shields.io/badge/Поддержать-ea4aaa?style=flat-square" alt="Поддержать проект">
  </a>
</p>

---

## Обзор

**RClone Manager** упрощает управление файлами и синхронизацию с удалёнными хранилищами. Используя Rclone в качестве основы, приложение предоставляет полноценную настольную среду со встроенным файловым менеджером **Nautilus** для переноса, монтирования и публикации удалённых файлов.

- 📂 **Файловый менеджер Nautilus:** просмотр, редактирование, перемещение, копирование, переименование и удаление удалённых файлов.
- 👁️ **Просмотр файлов:** встроенный просмотр видео, изображений, PDF, аудио и текстовых файлов.
- ⚙️ **Монтирование и серверы:** удобное управление подключениями и серверами WebDAV, SFTP, HTTP и FTP.
- 🔄 **Наблюдение за заданиями:** контроль передачи файлов и ограничение пропускной способности в реальном времени.
- 🌐 **Серверный режим:** используйте [RClone Manager Headless](headless/README.md) для запуска в качестве веб-сервера на VPS или NAS.

---

## Скриншот

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="Интерфейс RClone Manager" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 Больше примеров интерфейса доступно в <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">галерее Wiki</a></b>.</i>
</p>

---

## Установка и загрузка

Установите RClone Manager с помощью предпочитаемого пакетного менеджера или загрузите готовые файлы со страницы [Releases](https://github.com/Zarestia-Dev/rclone-manager/releases).

### Linux

| Источник             | Версия                                                                                                                                                                                  | Команда установки или загрузка                                                                                              |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **AUR**              | [![Версия AUR](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                   | `yay -S rclone-manager`                                                                                                     |
| **AUR (Git)**        | [![Версия AUR](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                           | `yay -S rclone-manager-git`                                                                                                 |
| **Flathub**          | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager)     | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                     |
| **Прямая загрузка**  | [![Выпуск GitHub](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [Последние выпуски: .deb, .rpm, .AppImage и переносимый tar.gz](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Руководство:** [Установка в Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) — устранение проблем с Flatpak, снимками и другими компонентами.

### macOS

| Источник             | Версия                                                                                                                                                                                                        | Команда установки или загрузка                                                       |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| **Homebrew**         | [![Версия Homebrew](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew install --cask rclone-manager`               |
| **Прямая загрузка**  | [![Выпуск GitHub](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                        | [Установщик DMG](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)     |

> 📚 **Руководство:** [Установка в macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) — настройка macFUSE и устранение блокировок Gatekeeper.

### Windows

| Источник             | Версия                                                                                                                                                                                                           | Команда установки или загрузка                                                              |
| :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **Winget**           | [![Версия Winget](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                               |
| **Chocolatey**       | [![Версия Chocolatey](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                              | `choco install rclone-manager`                                                               |
| **Scoop**            | [![Версия Scoop](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                   | `scoop bucket add extras && scoop install rclone-manager`                                    |
| **Прямая загрузка**  | [![Выпуск GitHub](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                           | [Установщик или переносимый EXE](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Руководство:** [Установка в Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) — требования WinFsp для монтирования и сведения о SmartScreen.

> 🛠️ **Системные требования:** для монтирования дисков необходимы WinFsp в Windows, macFUSE в macOS или FUSE3 в Linux. При отсутствии Rclone приложение загружает его автоматически. Подробности доступны в разделе [системных требований](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies).

---

## Разработка и поддержка

- **Сборка из исходного кода:** используйте [руководство по сборке](https://hakanismail.info/zarestia/rclone-manager/docs/building).
- **Качество кода:** правила оформления описаны в файле [LINTING.md](LINTING.md).
- **Устранение проблем:** посетите [Wiki](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) или ознакомьтесь с файлом [ISSUES.md](ISSUES.md).

---

## Участие в разработке

Приветствуются любые виды помощи проекту.

- 🌍 **Переводы:** присоединитесь к [проекту Crowdin](https://crowdin.com/project/rclone-manger) или прочитайте [руководство по переводу](CONTRIBUTING.md#adding-translations).
- 🐛 **Ошибки и предложения:** создайте [issue](https://github.com/Zarestia-Dev/rclone-manager/issues) или посетите [доску проекта](https://github.com/users/Zarestia-Dev/projects/2).
- 🔧 **Изменения кода:** перед отправкой Pull Request прочитайте [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Лицензия и поддержка

- **Лицензия:** проект распространяется по лицензии [GNU GPLv3](LICENSE) и может свободно использоваться, изменяться и распространяться.
- **Поддержка:** поставьте проекту звезду ⭐ на GitHub.
- **Пожертвования:** поддержать разработку можно на [странице проекта](https://hakanismail.info/zarestia/support).

<p align="center">
  Создано командой Zarestia Dev<br>
  <sub>Работает на основе Rclone | Создано с использованием Angular и Tauri</sub>
</p>