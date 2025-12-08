<h1 align="center">🌐 RClone Manager Headless</h1>

<p align="center">
  <b>Run RClone Manager as a web server on any Linux machine</b><br>
  <i>Perfect for servers, NAS devices, and remote systems</i>
</p>

---

## 📖 What is RClone Manager Headless?

RClone Manager Headless is a **web server version** of RClone Manager that runs on Linux servers without a graphical desktop environment. Access the full RClone Manager interface through your web browser from any device on your network.

### ✨ Why Headless Mode?

- 🖥️ **Run on servers** – Perfect for headless Linux servers, NAS devices, or VPS
- 🌐 **Access anywhere** – Manage your rclone remotes from any device with a web browser
- 🔒 **Secure by default** – Built-in authentication and optional TLS/HTTPS support
- ⚡ **Lightweight** – Minimal resource usage compared to running a full desktop application
- 🚀 **Same features** – ~99% feature parity with the desktop version

---

## ⚠️ Important Technical Note

RClone Manager Headless is built using **Tauri**, a desktop application framework. To make it work on servers without a display, we use a **virtual display (Xvfb)** that runs in the background. This means:

### Requirements

- **GTK/WebKit libraries** – The application requires some GUI libraries (automatically installed)
- **Xvfb** – Virtual display server (automatically installed and managed)
- **Not "truly" headless** – It's a desktop app running on a virtual display, not a pure web server

### Why This Approach?

- ✅ **99% feature parity** with desktop version
- ✅ **Shared codebase** – Same interface and functionality
- ✅ **Faster development** – Updates and features arrive simultaneously
- ✅ **Proven stability** – Uses the same tested code as desktop builds
- ⚠️ **Extra dependencies** – Requires a few more libraries than a pure web server would

The approach works reliably on servers, but be aware that it's a desktop application adapted for server use, not a native web server. In practice, this distinction rarely matters for day-to-day use.

---

## 📦 Downloads

#### 🌐 Linux Headless (Web Server)

**For servers, NAS devices, and remote Linux systems:**

| Repository          | Version                                                                                                                                                                                               | Install Command                                                                                                                                                                          |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUR**             | [![AUR Version](https://img.shields.io/aur/version/rclone-manager-headless?style=flat&label=)](https://aur.archlinux.org/packages/rclone-manager-headless)                                            | `yay -S rclone-manager-headless`                                                                                                                                                         |
| **Direct Download** | [![Latest Headless](https://img.shields.io/github/v/release/Zarestia-Dev/rclone-manager?style=flat&label=&color=2ec27e)](https://github.com/Zarestia-Dev/rclone-manager/releases/tag/headless-v0.1.8) | <a href="https://github.com/Zarestia-Dev/rclone-manager/releases/tag/headless-v0.1.8"><img src="https://img.shields.io/badge/Download-3584e4?style=flat&logo=github" alt="Download"></a> |

---

## 🚀 Quick Start

### Basic Usage

```bash
# Start the server (default: http://0.0.0.0:8080)
rclone-manager-headless

# Access via browser - use your server's IP address
# Find your IP: ip addr show | grep inet
# Then open: http://YOUR-SERVER-IP:8080
```

### Command Line Options

```bash
rclone-manager-headless [OPTIONS]

Options:
  -H, --host <HOST>          Host address to bind to [default: 0.0.0.0]
  -p, --port <PORT>          Port to listen on [default: 8080]
  -u, --user <USER>          Username for Basic Authentication
      --pass <PASS>          Password for Basic Authentication
      --tls-cert <PATH>      Path to TLS certificate file
      --tls-key <PATH>       Path to TLS key file
  -h, --help                 Print help information
```

---

## 🔧 Configuration

### Environment Variables

You can configure the server using environment variables instead of command-line arguments:

```bash
# Set environment variables
export RCLONE_MANAGER_HOST="0.0.0.0"
export RCLONE_MANAGER_PORT="8080"
export RCLONE_MANAGER_USER="admin"
export RCLONE_MANAGER_PASS="secretpassword"
export RCLONE_MANAGER_TLS_CERT="/path/to/cert.pem"
export RCLONE_MANAGER_TLS_KEY="/path/to/key.pem"

# Start the server
rclone-manager-headless
```

### Systemd Service

A production-ready systemd service file is included in the repository. Download and install it:

```bash
# Download the service file
wget https://raw.githubusercontent.com/Zarestia-Dev/rclone-manager/master/headless/rclone-manager-headless.service

# Create dedicated user with home directory (recommended for security)
sudo useradd -r -m -s /bin/false -d /home/rclone-manager rclone-manager

# Create required directories
sudo chown -R rclone-manager:rclone-manager /home/rclone-manager

# Note: The app stores data in ~/.local/share/com.rclone.manager.headless
# and uses ~/.config/rclone for rclone configuration

# Edit the service file to customize settings
sudo nano rclone-manager-headless.service
# Change the --user and --pass values
# Adjust port, host, and other options as needed

# Install the service
sudo cp rclone-manager-headless.service /etc/systemd/system/

# Enable and start the service
sudo systemctl daemon-reload
sudo systemctl enable rclone-manager-headless
sudo systemctl start rclone-manager-headless
sudo systemctl status rclone-manager-headless
```

#### Service Features

The included service file provides:

- ✅ **Automatic restart** on failure with rate limiting
- ✅ **Security hardening** (NoNewPrivileges, ProtectSystem, PrivateTmp)
- ✅ **Resource limits** (Memory and CPU quotas)
- ✅ **Proper logging** via systemd journal
- ✅ **Network dependency** (waits for network to be online)
- ✅ **Dedicated user** for isolation

#### View Logs

```bash
# Follow logs in real-time
journalctl -u rclone-manager-headless -f

# View recent logs
journalctl -u rclone-manager-headless -n 100

# View logs since boot
journalctl -u rclone-manager-headless -b
```

---

## 🆚 Desktop vs Headless

| Feature               | Desktop       | Headless    |
| --------------------- | ------------- | ----------- |
| **UI Access**         | Native window | Web browser |
| **System Tray**       | ✅ Yes        | ❌ No       |
| **Global Shortcuts**  | ✅ Yes        | ❌ No       |
| **Auto-Updates**      | ✅ Yes        | ✅ Yes      |
| **Remote Management** | ✅ Full       | ✅ Full     |
| **Mounts & Serves**   | ✅ Full       | ✅ Full     |
| **Scheduled Tasks**   | ✅ Full       | ✅ Full     |
| **VFS Control**       | ✅ Full       | ✅ Full     |
| **Authentication**    | Local only    | ✅ Built-in |

---

## 🤝 Support & Community

- 📖 **Wiki**: [Documentation & Guides](https://github.com/Zarestia-Dev/rclone-manager/wiki)
- 🐛 **Issues**: [Report a bug](https://github.com/Zarestia-Dev/rclone-manager/issues/new/choose)
- 💬 **Discussions**: [Join the conversation](https://github.com/Zarestia-Dev/rclone-manager/discussions)
- 📦 **Releases**: [Download latest version](https://github.com/Zarestia-Dev/rclone-manager/releases)

---

## 📝 License

GNU General Public License v3.0 - See [LICENSE](../LICENSE) for details.

---

<p align="center">
  <b>Happy cloud managing from your server! ☁️</b><br>
  <sub>Made with ❤️ by the Zarestia Dev Team</sub>
</p>
