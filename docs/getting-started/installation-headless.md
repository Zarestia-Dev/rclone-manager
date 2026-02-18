# Installation: Headless Server

**Run RClone Manager as a web server on any Linux machine.**
*Perfect for servers, NAS devices, and remote systems.*

---

## 🧐 What is Headless Mode?
RClone Manager Headless is a web server version that runs on Linux servers without a graphical desktop environment. It serves the full interface to your web browser.

> **⚠️ Important Technical Note:** RClone Manager Headless is built using **Tauri**. To make it work on servers without a display, it uses a **virtual display (Xvfb)** in the background.
> * **Requirement:** It requires GTK/WebKit libraries and Xvfb.
> * **Docker:** The official image handles all of this automatically.
> * **Manual:** You may need to install these dependencies manually.

---

## 🐳 Method 1: Docker (Recommended)
Pre-built multi-architecture images (`amd64`, `arm64`) are available.

### Quick Start (No Auth)
```bash
docker run -d \
  --name rclone-manager \
  -p 8080:8080 \
  -p 53682:53682 \
  -v rclone-config:/home/rclone-manager/.config/rclone \
  -v rclone-manager-config:/home/rclone-manager/.local/share/com.rclone.manager.headless \
  ghcr.io/zarestia-dev/rclone-manager:latest

```

* **Port 8080:** Web Interface.
* **Port 53682:** Rclone OAuth Redirect (Required for connecting Google Drive, OneDrive, etc.).

### Docker Compose

We support **Profiles** for different configurations (Auth, TLS). Create a `docker-compose.yml`:

```yaml
services:
  rclone-manager:
    image: ghcr.io/zarestia-dev/rclone-manager:latest
    container_name: rclone-manager-headless
    restart: unless-stopped
    ports:
      - "8080:8080"
      - "53682:53682"
    volumes:
      - rclone-config:/home/rclone-manager/.config/rclone
      - rclone-manager-config:/home/rclone-manager/.local/share/com.rclone.manager.headless
    profiles:
      - "" # Default profile

  # See Configuration page for Auth/TLS profiles

```

Start it:

```bash
docker-compose up -d

```

---

## 🐧 Method 2: Native Binary

Download and install directly on your Linux system.

### Downloads

Visit the **[Releases Page](https://github.com/Zarestia-Dev/rclone-manager/releases)** to get the latest `headless` tag.
*(Note: Headless builds often share version numbers with the Desktop release. Check the assets list for `headless` tagged packages.)*

### Debian / Ubuntu

```bash
# Example for v0.1.8 - Check releases page for the latest link
wget https://github.com/Zarestia-Dev/rclone-manager/releases/download/headless-v0.1.8/rclone-manager-headless_0.1.8_amd64.deb
sudo dpkg -i rclone-manager-headless_0.1.8_amd64.deb
sudo apt-get install -f # Install dependencies (xvfb, gtk3, etc.)

```

### Fedora / RHEL

```bash
wget https://github.com/Zarestia-Dev/rclone-manager/releases/download/headless-v0.1.8/rclone-manager-headless-0.1.8-1.x86_64.rpm
sudo rpm -i rclone-manager-headless-0.1.8-1.x86_64.rpm

```

### Arch Linux (AUR)

```bash
yay -S rclone-manager-headless

```

---

## ⚙️ Method 3: Systemd Service

Run the application as a background service for automatic startup.

**1. Create Dedicated User:**
Create the system user required by the service file.

```bash
sudo useradd -r -m -s /bin/false -d /home/rclone-manager rclone-manager
sudo chown -R rclone-manager:rclone-manager /home/rclone-manager

```

**2. Download Service File:**
Download the configuration directly to systemd ([File](https://raw.githubusercontent.com/Zarestia-Dev/rclone-manager/master/headless/rclone-manager-headless.service)).

```bash
sudo wget -O /etc/systemd/system/rclone-manager-headless.service https://raw.githubusercontent.com/Zarestia-Dev/rclone-manager/master/headless/rclone-manager-headless.service

```

**3. Enable & Start:**
Reload the daemon and start the service.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rclone-manager-headless

```


---

## 🔄 Updating

**Docker:**

```bash
docker pull ghcr.io/zarestia-dev/rclone-manager:latest
docker-compose up -d

```

**Binary:**
Download the new `.deb`/`.rpm`/`.AppImage` and install it over the old one.

**Systemd:**
Restart the service after updating: `sudo systemctl restart rclone-manager-headless`

