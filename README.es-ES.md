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
  <a href="CONTRIBUTING.md#adding-translations">Ayuda a traducir</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>Una interfaz gráfica potente y multiplataforma para gestionar remotos de Rclone con estilo y facilidad.</b><br>
  <i>Creado con Angular 22 + Tauri · Soporte para Linux • Windows • macOS • ARM</i>
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

## Descripción general

**RClone Manager** simplifica la gestión y sincronización de archivos remotos. Utilizando Rclone como base, ofrece un entorno de escritorio con un gestor de archivos integrado (**Nautilus**) para transferir, montar y servir archivos remotos sin esfuerzo.

- 📂 **Gestor de archivos Nautilus:** Navega, edita, mueve, copia, renombra y elimina archivos remotos.
- 👁️ **Visor de archivos:** Vista previa integrada para vídeos, imágenes, PDFs, audio y texto.
- ⚙️ **Montar y Servir:** Controles de montaje sencillos y gestión de servidores (WebDAV, SFTP, HTTP, FTP).
- 🔄 **Monitor de trabajos:** Supervisión de transferencias y control de ancho de banda en tiempo real.
- 🌐 **Modo Headless (Sin cabecera):** ¡Consulta [RClone Manager Headless](headless/README.md) para ejecutarlo como servidor web en VPS/NAS!

---

## Captura de pantalla

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="Interfaz de RClone Manager" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 ¿Quieres ver más? Echa un vistazo a la <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Galería de la Wiki</a></b> para ver todas las funciones.</i>
</p>

---

## Instalación y Descargas

Instala RClone Manager usando tu gestor de paquetes preferido, o descarga los binarios directamente desde la página de [Versiones](https://github.com/Zarestia-Dev/rclone-manager/releases).

### Linux

| Origen               | Versión                                                                                                                                                                                 | Comando de instalación / Descarga                                                                                            |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **AUR**              | [![Versión AUR](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                   | `yay -S rclone-manager`                                                                                                      |
| **AUR (Git)**        | [![Versión AUR](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                           | `yay -S rclone-manager-git`                                                                                                  |
| **Flathub**          | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager)     | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                      |
| **Descarga directa** | [![Última versión](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [Últimas versiones (.deb, .rpm, .AppImage, Portable tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guía:** [Wiki: Instalación - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) (resolución de problemas con Flatpak, snap, etc.)

### macOS

| Origen               | Versión                                                                                                                                                                                                           | Comando de instalación / Descarga                                                |
| :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------- |
| **Homebrew**         | [![Versión de Homebrew](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew trust Zarestia-Dev/zarestia && brew install --cask rclone-manager`           |
| **Descarga directa** | [![Última versión](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                           | [Instalador DMG](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guía:** [Wiki: Instalación - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) (soluciones para macFUSE y Gatekeeper)

### Windows

| Origen               | Versión                                                                                                                                                                                                              | Comando de instalación / Descarga                                                           |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **Winget**           | [![Versión de Winget](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                              |
| **Chocolatey**       | [![Versión de Chocolatey](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                              | `choco install rclone-manager`                                                              |
| **Scoop**            | [![Versión de Scoop](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                   | `scoop bucket add extras && scoop install rclone-manager`                                   |
| **Descarga directa** | [![Última versión](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                              | [Instalador / EXE Portable](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guía:** [Wiki: Instalación - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) (requisitos de montaje de WinFsp y SmartScreen)

> 🛠️ **Requisitos del sistema:** Montar unidades requiere WinFsp (Windows), macFUSE (macOS) o FUSE3 (Linux). Rclone se descarga automáticamente si no se encuentra en el sistema. Consulta [Wiki: Requisitos del sistema](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies).

---

## Soporte y Desarrollo

- **Compilar desde el código fuente:** Consulta la [Guía de compilación](https://hakanismail.info/zarestia/rclone-manager/docs/building).
- **Calidad del código:** Visita [LINTING.md](LINTING.md) para conocer las pautas de estilo.
- **Solución de problemas:** Visita nuestra [Wiki de solución de problemas](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) o lee [ISSUES.md](ISSUES.md) para notas específicas de cada plataforma.

---

## Contribuir

¡Toda contribución es bienvenida!

- 🌍 **Traducciones:** Únete al [Proyecto en Crowdin](https://crowdin.com/project/rclone-manger) o lee la [Guía de traducción](CONTRIBUTING.md#adding-translations).
- 🐛 **Errores y funciones:** Abre un [problema](https://github.com/Zarestia-Dev/rclone-manager/issues) o consulta el [Tablero del proyecto](https://github.com/users/Zarestia-Dev/projects/2).
- 🔧 **Cambios en el código:** Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de enviar un Pull Request.

---

## Licencia y Soporte

- **Licencia:** Distribuido bajo la licencia [GNU GPLv3](LICENSE) – libre para usar, modificar y distribuir.
- **Soporte:** Si te gusta este proyecto, ¡considera dejar una ⭐ en GitHub!
- **Donar:** Si RClone Manager te ahorra tiempo, considera [apoyar el desarrollo](https://hakanismail.info/zarestia/support) ❤️

<p align="center">
  Creado con ❤️ por el equipo de desarrollo de Zarestia<br>
  <sub>Desarrollado por Rclone | Construido con Angular y Tauri</sub>
</p>
