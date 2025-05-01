<h1 align="center">
  <img src="src/assets/rclone.svg" alt="Rclone Manager" height="180">
  <br>
  Rclone Manager
</h1>

<p align="center">
  <b>Cross-platform GUI for managing Rclone remotes with style.</b><br>
  <i>Built with Angular + Tauri · Linux support (Windows/macOS planned)</i>
</p>

---

## 🌐 Overview

**Rclone Manager** is a **cross-platform (currently Linux-only)** GUI application to help users manage [Rclone](https://rclone.org/) remotes with a modern interface.

> ⚠️ **Actively developed** – Expect frequent updates and improvements.

---

## 🎨 Design Philosophy

💡 **Caotic Design** – A unique mix of **GTK styling**, **Angular Material**, and **FontAwesome**, creating a minimalist yet modern look.

---

## 📸 Screenshots

📷 *Coming soon...*

---

## 🚀 Features

- 🛠 **Remote Management** – Add, edit, and delete remotes easily.
- 🔐 **OAuth Support** – Authenticate with popular providers effortlessly.
- ☁️ **Supported Remotes** – Google Drive, Dropbox, OneDrive, AWS S3, and many more.
- 📦 **Mounting** – Native or systemd-based remote mount/unmount functionality.
- ⚙️ **Advanced VFS Options** – Tune caching, read sizes, and other performance options.
- 🖥 **Tray Icon Support** – Quick access to your remotes from the system tray.
- 🌗 **Light & Dark Modes** – GTK-inspired themes with a modern, responsive layout.
- 🧪 **Cross-Platform Architecture** – Tauri + Angular. **Linux ready**, Windows/macOS coming soon.

---

## 🔧 Tech Stack

- **Frontend**: Angular + Angular Material + FontAwesome
- **Backend**: Tauri (Rust)
- **Styling**: GTK-inspired custom theming

---

## 📦 Downloads

👉 Get the latest release from:

- 🔗 [GitLab Releases](https://gitlab.com/Hakanbaban53/rclone-manager/-/releases)
- 🔗 [GitHub Releases](https://github.com/Hakanbaban53/rclone-manager/releases)

> 🚧 Only Linux builds are currently provided. Windows and macOS support is on the roadmap.

---

## 🛠️ Installation

### 🔍 Prerequisites

- [Rclone](https://rclone.org/downloads/) – Required for remote management
- Node.js – For Angular development
- Rust & Cargo – For building Tauri

### 💻 Development Setup

```bash
# Clone from GitLab
git clone https://gitlab.com/Hakanbaban53/rclone-manager.git
cd rclone-manager

# Or from GitHub
git clone https://github.com/Hakanbaban53/rclone-manager.git
cd rclone-manager

# Install dependencies
npm install

# Run the app
npm run tauri dev
```

⚠️ **Note:** Do not use `ng serve` — the app depends on **Tauri APIs**.

### 📦 Build for Production

```bash
npm run tauri build
```

---

## 🧑‍💻 Contributing

Contributions welcome! 🚀

- Report bugs & suggest features on:
  - [GitLab Issues](https://gitlab.com/Hakanbaban53/rclone-manager/issues)
  - [GitHub Issues](https://github.com/Hakanbaban53/rclone-manager/issues)
- Submit pull requests and help improve the project!

---

## 📜 License

This project is licensed under the **[GNU GPLv3](LICENSE)**.

---

## 📬 Contact

Have questions or ideas? Reach out via:

- [GitLab Issues](https://gitlab.com/Hakanbaban53/rclone-manager/issues)
- [GitHub Issues](https://github.com/Hakanbaban53/rclone-manager/issues)