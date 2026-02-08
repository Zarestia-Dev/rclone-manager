<h1 align="center">🌐 RClone Manager Headless</h1>

<p align="center">
  <b>Run RClone Manager as a web server on any Linux machine</b><br>
  <i>Perfect for servers, NAS devices, and remote systems</i>
</p>

<p align="center">
  <a href="https://github.com/Zarestia-Dev/rclone-manager/wiki/Installation-Headless">
    <img src="https://img.shields.io/badge/📚_Read_Installation_Guide-blue?style=for-the-badge" alt="Read Installation Guide">
  </a>
  <a href="https://github.com/Zarestia-Dev/rclone-manager/wiki/Configuration-Headless">
    <img src="https://img.shields.io/badge/⚙️_Configuration_&_Auth-gray?style=for-the-badge" alt="Configuration Guide">
  </a>
</p>

---

## 📖 Introduction

**RClone Manager Headless** brings the full power of the desktop application to your browser. It is designed for:

- **Linux Servers & VPS**
- **NAS Devices** (Unraid, Synology, TrueNAS)
- **Docker Environments**

### ⚠️ Architecture Note (Tauri + Xvfb)

This is a **headless desktop application**, not a native web server. It uses **Xvfb** (Virtual Framebuffer) to run the GUI in the background and streams the interface to your browser.

- **Docker:** Handles all dependencies automatically (Recommended).
- **Binary:** Requires `xvfb`, `gtk3`, and `webkit2gtk` installed on your system.

---

## 🚀 Quick Start (Docker)

The easiest way to run the application.

```bash
docker run -d \
  --name rclone-manager \
  --restart=unless-stopped \
  -p 8080:8080 \
  -p 53682:53682 \
  -v rclone-config:/home/rclone-manager/.config/rclone \
  -v rclone-manager-data:/home/rclone-manager/.local/share/com.rclone.manager.headless \
  ghcr.io/zarestia-dev/rclone-manager:latest

```

- **Web UI:** `http://YOUR_IP:8080`
- **OAuth Redirect:** Port `53682` (Required for Google Drive/OneDrive auth).

> 🔐 **Need Authentication or HTTPS?**
> Check the **[Configuration Guide](https://github.com/Zarestia-Dev/rclone-manager/wiki/Configuration-Headless)** for enabling password protection and TLS.

---

## 📦 Downloads

| Repository                 | Version                                                                                                                                                                                               | Install Command                                                                                                                                                                          |
| :------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUR**                    | [![AUR Version](https://img.shields.io/aur/version/rclone-manager-headless?style=flat&label=)](https://aur.archlinux.org/packages/rclone-manager-headless)                                            | `yay -S rclone-manager-headless`                                                                                                                                                         |
| **Direct Download**        | [![Latest Headless](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/tag/headless-v0.1.9) | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/tag/headless-v0.1.9"><img src="https://img.shields.io/badge/Download-3584e4?style=flat&logo=github" alt="Download"></a> |
| **GitHub Packages (GHCR)** | <a href="https://github.com/Zarestia-Dev/rclone-manager/pkgs/container/rclone-manager"><img src="https://img.shields.io/badge/Container-style=flat&logo=docker" alt="GHCR Container"></a>             | `docker pull ghcr.io/zarestia-dev/rclone-manager:latest`                                                                                                                                 |

---

## 🆚 Desktop vs Headless

| Feature            | Desktop App   | Headless Server          |
| :----------------- | :------------ | :----------------------- |
| **Interface**      | Native Window | Web Browser              |
| **Remote Control** | Local Only    | ✅ Network Accessible    |
| **Authentication** | System User   | ✅ Built-in (Basic Auth) |
| **Auto-Updates**   | ✅ Yes        | ✅ Yes (via Docker Pull) |

---

## 🔗 Resources

- 📚 **[Documentation Wiki](https://github.com/Zarestia-Dev/rclone-manager/wiki)**
- 🐛 **[Report a Bug](https://github.com/Zarestia-Dev/rclone-manager/issues)**
- 💬 **[Discussions](https://github.com/Zarestia-Dev/rclone-manager/discussions)**

<p align="center">
<sub>Made with ❤️ by the Zarestia Dev Team</sub>
</p>
