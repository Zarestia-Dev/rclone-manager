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
  <a href="README.pt-BR.md">🇧🇷 Português-Brasil</a> •
  <a href="README.ru-RU.md">🇷🇺 Русский</a> •
  <a href="CONTRIBUTING.md#adding-translations">Ajude a traduzir</a> •
  <a href="https://crowdin.com/project/rclone-manger">Crowdin</a>
</p>

<p align="center">
  <b>Uma interface gráfica poderosa e multiplataforma para gerenciar remotos do Rclone com estilo e facilidade.</b><br>
  <i>Desenvolvido com Angular 22 + Tauri · Linux • Windows • macOS • Suporte a ARM</i>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs">
    <img src="https://img.shields.io/badge/📚_Documentação_Wiki-blue?style=flat-square" alt="Documentação">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/releases">
    <img src="https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat-square&color=2ec27e" alt="Último Lançamento">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/Zarestia-Dev/rclone-manager?style=flat-square&color=9141ac" alt="Licença">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/stargazers">
    <img src="https://img.shields.io/github/stars/Zarestia-Dev/rclone-manager?style=flat-square&color=3584e4" alt="Estrelas">
  </a>
  <a href="https://crowdin.com/project/rclone-manger">
    <img src="https://badges.crowdin.net/rclone-manger/localized.svg?style=flat-square" alt="Status do Crowdin">
  </a>
  <a href="https://hakanismail.info/zarestia/support">
    <img src="https://img.shields.io/badge/Doar-ea4aaa?style=flat-square" alt="Doar">
  </a>
</p>

---

## Visão Geral

O **RClone Manager** simplifica o gerenciamento e a sincronização de arquivos remotos. Usando o Rclone como base, ele oferece um ambiente de desktop com um gerenciador de arquivos integrado (**Nautilus**) para transferir, montar e servir arquivos remotos sem esforço.

- 📂 **Gerenciador de Arquivos Nautilus:** Navegue, edite, mova, copie, renomeie e exclua arquivos remotos.
- 👁️ **Visualizador de Arquivos:** Visualizações integradas para vídeos, imagens, PDFs, áudio e texto.
- ⚙️ **Montar e Servir:** Controles fáceis de montagem e gerenciamento de servidores (WebDAV, SFTP, HTTP, FTP).
- 🔄 **Monitor de Tarefas:** Monitoramento de transferências em tempo real e controle de largura de banda.
- 🌐 **Modo Headless:** Confira o [RClone Manager Headless](headless/README.md) para executá-lo como um servidor web no seu VPS/NAS!

---

## Captura de Tela

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dark-ui.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/desktop-ui.png">
    <img alt="Interface Desktop do RClone Manager" src="assets/desktop-ui.png" width="90%">
  </picture>
  <br>
  <i>📖 Quer ver mais? Confira a <b><a href="https://hakanismail.info/zarestia/rclone-manager/docs/gallery">Galeria da Wiki</a></b> com todos os recursos.</i>
</p>

---

## Instalação e Downloads

Instale o RClone Manager usando o seu gerenciador de pacotes preferido ou baixe os binários independentes diretamente da página de [Lançamentos (Releases)](https://github.com/Zarestia-Dev/rclone-manager/releases).

### Linux

| Fonte               | Versão                                                                                                                                                                                  | Comando de Instalação / Download                                                                                           |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **AUR**             | [![Versão AUR](https://img.shields.io/aur/version/rclone-manager?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager)                                    | `yay -S rclone-manager`                                                                                                    |
| **AUR (Git)**       | [![Versão AUR](https://img.shields.io/aur/version/rclone-manager-git?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-git)                            | `yay -S rclone-manager-git`                                                                                                |
| **Flathub**         | [![Flathub](https://img.shields.io/flathub/v/io.github.zarestia_dev.rclone-manager?style=flat&label=&color=2ec27e)](https://flathub.org/apps/io.github.zarestia_dev.rclone-manager)     | `flatpak install io.github.zarestia_dev.rclone-manager`                                                                    |
| **Download Direto** | [![Lançamento GitHub](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) | [Últimos Lançamentos (.deb, .rpm, .AppImage, Portátil tar.gz)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guia:** [Wiki: Instalação - Linux](https://hakanismail.info/zarestia/rclone-manager/docs/installation-linux) (solução de problemas do Flatpak, snapshots, etc.)

### macOS

| Fonte               | Versão                                                                                                                                                                                                         | Comando de Instalação / Download                                                |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| **Homebrew**        | [![Versão Homebrew](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/homebrew-zarestia/blob/main/Casks/rclone-manager.rb) | `brew tap Zarestia-Dev/zarestia && brew trust Zarestia-Dev/zarestia && brew install --cask rclone-manager`          |
| **Download Direto** | [![Lançamento GitHub](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                        | [Instalador DMG](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guia:** [Wiki: Instalação - macOS](https://hakanismail.info/zarestia/rclone-manager/docs/installation-macos) (correções para macFUSE e Gatekeeper)

### Windows

| Fonte               | Versão                                                                                                                                                                                                            | Comando de Instalação / Download                                                           |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **Winget**          | [![Versão Winget](https://img.shields.io/winget/v/RClone-Manager.rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RClone-Manager/rclone-manager) | `winget install RClone-Manager.rclone-manager`                                             |
| **Chocolatey**      | [![Versão Chocolatey](https://img.shields.io/chocolatey/v/rclone-manager?style=flat&label=&color=2ec27e)](https://community.chocolatey.org/packages/rclone-manager)                                               | `choco install rclone-manager`                                                             |
| **Scoop**           | [![Versão Scoop](https://img.shields.io/scoop/v/rclone-manager?bucket=extras&style=flat&label=&color=2ec27e)](https://github.com/ScoopInstaller/Extras/blob/master/bucket/rclone-manager.json)                    | `scoop bucket add extras && scoop install rclone-manager`                                  |
| **Download Direto** | [![Lançamento GitHub](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/latest)                           | [Instalador / EXE Portátil](https://github.com/Zarestia-Dev/rclone-manager/releases/latest) |

> 📚 **Guia:** [Wiki: Instalação - Windows](https://hakanismail.info/zarestia/rclone-manager/docs/installation-windows) (requisitos de montagem do WinFsp e SmartScreen)

> 🛠️ **Requisitos do Sistema:** A montagem de unidades requer WinFsp (Windows), macFUSE (macOS) ou FUSE3 (Linux). O Rclone em si é baixado automaticamente se estiver ausente. Veja a [Wiki: Requisitos do Sistema](https://hakanismail.info/zarestia/rclone-manager/docs/Installation#%EF%B8%8F-dependencies).

---

## Desenvolvimento e Suporte

- **Compilando a partir do Código-Fonte:** Consulte o [Guia de Compilação](https://hakanismail.info/zarestia/rclone-manager/docs/building).
- **Qualidade do Código:** Verifique o [LINTING.md](LINTING.md) para diretrizes de estilo.
- **Solução de Problemas:** Visite nossa [Wiki de Solução de Problemas](https://hakanismail.info/zarestia/rclone-manager/docs/troubleshooting) ou leia o [ISSUES.md](ISSUES.md) para notas específicas de plataformas.

---

## Contribuindo

Aceitamos contribuições de todas as formas!

- 🌍 **Traduções:** Junte-se ao [Projeto Crowdin](https://crowdin.com/project/rclone-manger) ou leia o [Guia de Tradução](CONTRIBUTING.md#adding-translations).
- 🐛 **Bugs e Recursos:** Abra uma [issue](https://github.com/Zarestia-Dev/rclone-manager/issues) ou verifique o [Quadro do Projeto](https://github.com/users/Zarestia-Dev/projects/2).
- 🔧 **Alterações de Código:** Por favor, leia o [CONTRIBUTING.md](CONTRIBUTING.md) antes de enviar um Pull Request.

---

## Licença e Suporte

- **Licença:** Licenciado sob a [GNU GPLv3](LICENSE) – livre para usar, modificar e distribuir.
- **Suporte:** Se você gosta deste projeto, por favor, considere deixar uma ⭐ no GitHub!
- **Doar:** Se o RClone Manager economiza seu tempo, considere [apoiar o desenvolvimento](https://hakanismail.info/zarestia/support) ❤️

<p align="center">
  Desenvolvido com ❤️ pela Equipe de Desenvolvimento Zarestia<br>
  <sub>Distribuído por Rclone | Construído com Angular & Tauri</sub>
</p>
