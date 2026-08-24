<h1 align="center">🌐 RClone Manager Headless</h1>

<p align="center">
  <b>Run RClone Manager as a web server on any Linux machine</b><br>
  <i>Perfect for servers, NAS devices, and remote systems</i>
</p>

<p align="center">
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs/installation-headless">
    <img src="https://img.shields.io/badge/📚_Read_Installation_Guide-blue?style=for-the-badge" alt="Read Installation Guide">
  </a>
  <a href="https://hakanismail.info/zarestia/rclone-manager/docs/configuration-headless">
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
  -v rclone-config:/config \
  -v rclone-manager-data:/data \
  ghcr.io/zarestia-dev/rclone-manager:latest
```

- **Web UI:** `http://YOUR_IP:8080`
- **Volumes:** `/data` (app data & binaries) and `/config` (`rclone.conf`).
- **OAuth / Cloud Auth:** Use `--net=host` or SSH port forwarding (`ssh -L 53682:127.0.0.1:53682 user@host`) for Google Drive/OneDrive 1-click OAuth.

> 🔐 **Need Authentication, Secret Keys, or HTTPS?**
> Check the **[Configuration Guide](https://hakanismail.info/zarestia/rclone-manager/docs/configuration-headless)** for enabling password protection, encrypted secrets, and TLS.

---

## 📦 Downloads

| Repository                 | Version                                                                                                                                                                                                          | Install Command                                                                                                                                                                          |
| :------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUR**                    | [![AUR Version](https://img.shields.io/aur/version/rclone-manager-headless?style=flat&label=&color=2ec27e)](https://aur.archlinux.org/packages/rclone-manager-headless)                                          | `yay -S rclone-manager-headless`                                                                                                                                                         |
| **Direct Download**        | [![GitHub Release](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/tag/headless-v0.3.2)             | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/tag/headless-v0.3.2"><img src="https://img.shields.io/badge/Download-3584e4?style=flat&logo=github" alt="Download"></a> |
| **GitHub Packages (GHCR)** | [![GitHub Container Registry](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/pkgs/container/rclone-manager) | `docker pull ghcr.io/zarestia-dev/rclone-manager:latest`                                                                                                                                 |

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

- 📚 **[Documentation Wiki](https://hakanismail.info/zarestia/rclone-manager/docs)**
- 🐛 **[Report a Bug](https://github.com/Zarestia-Dev/rclone-manager/issues)**
- 💬 **[Discussions](https://github.com/Zarestia-Dev/rclone-manager/discussions)**

<p align="center">
<sub>Made with ❤️ by the Zarestia Dev Team</sub>
</p>
