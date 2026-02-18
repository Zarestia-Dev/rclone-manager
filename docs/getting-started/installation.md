# Installation Overview

RClone Manager is available in two variants: the **Desktop Client** for personal computers and the **Headless Server** for remote access (NAS, VPS, Docker).

Select your preferred method below.

---

## 🖥️ Desktop Client
Designed for personal use on **Windows**, **Linux**, and **macOS**.

### Platform Guides
* **[Installation Windows](Installation-Windows)**
* **[Installation Linux](Installation-Linux)**
* **[Installation macOS](Installation-macOS)**

### Fast Download
You can always find the latest binaries for all platforms on our **[GitHub Releases Page](https://github.com/Zarestia-Dev/rclone-manager/releases)**.

---

## 🌐 Headless & Docker
Designed for servers, NAS, or running as a web service. Access the full UI via any web browser.

### 🐳 Docker (Recommended)
The official Docker image is available via the GitHub Container Registry.
* **[Docker Installation Guide](Installation-Docker)**
* **Image:** `ghcr.io/zarestia-dev/rclone-manager`
* **Registry:** [View on GitHub Packages](https://github.com/Zarestia-Dev/rclone-manager/pkgs/container/rclone-manager)

### 🐧 Manual Server Setup
Run directly on Linux/Node.js environments without Docker.
* **[Headless Setup Guide](Installation-Headless)**
* **Versions:** Headless versions follow specific tags (e.g., [`headless-v0.1.8`](https://github.com/Zarestia-Dev/rclone-manager/tree/headless-v0.1.8)).

---

## 📋 System Requirements

### 1. Rclone Binary (Core)
The application acts as a GUI for **[Rclone](https://rclone.org/)**.
* **Desktop:** The app acts as a setup wizard and will download/configure Rclone for you on the first run.
* **Headless/Docker:** Usually included in the container or requires a system-level install.

### 2. Mounting Drivers (Required for Mount features)
To mount your cloud storage as a local disk drive, you must have the filesystem driver installed for the host OS.

| Platform | Requirement | Official Source |
| :--- | :--- | :--- |
| **Windows** | **WinFsp** | [winfsp.dev](https://winfsp.dev/rel/) |
| **macOS** | **macFUSE** | [osxfuse.github.io](https://osxfuse.github.io/) |
| **Linux** | **fuse3** | Usually pre-installed |

> **Note:** If these drivers are missing, the Desktop app will prompt you to install them. For Docker/Headless, the host system must support FUSE and the container needs privileged access.