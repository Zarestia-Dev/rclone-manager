# Installation: Linux

Welcome to the Linux installation guide for **RClone Manager**!

RClone Manager supports almost all modern Linux distributions (Ubuntu, Fedora, Arch, etc.) and architectures including **x64 (AMD/Intel)** and **ARM64** (Raspberry Pi, etc.).

Choose your preferred installation method below.

---

## 🚀 Method 1: AppImage (Recommended)
The **AppImage** is a universal package that works on almost any Linux distribution without needing to install dependencies manually.

### 1. Download
Visit the **[Latest Releases Page](https://github.com/Zarestia-Dev/rclone-manager/releases)** and download the `.AppImage` file.

### 2. Run
1.  Open your terminal in the download folder.
2.  Make the file executable and run it:
    ```bash
    chmod +x RClone.Manager-*.AppImage
    ./RClone.Manager-*.AppImage
    ```

* **Tip:** You can use [Gear Lever](https://github.com/mijorus/gearlever) to easily integrate the AppImage into your system menu.

---

## 📦 Method 2: Native Packages (.deb, .rpm, AUR)

If you prefer installing via your system package manager for automatic updates and system integration.

### Debian / Ubuntu / Mint (`.deb`)
1.  Download the `.deb` file from **[Releases](https://github.com/Zarestia-Dev/rclone-manager/releases)**.
2.  Install via terminal:
    ```bash
    sudo dpkg -i RClone.Manager-*.deb
    sudo apt-get install -f  # Fixes any missing dependencies
    ```

### Fedora / RHEL / openSUSE (`.rpm`)
1.  Download the `.rpm` file from **[Releases](https://github.com/Zarestia-Dev/rclone-manager/releases)**.
2.  Install via terminal:
    ```bash
    # Fedora/RHEL
    sudo dnf install ./RClone.Manager-*.rpm

    # openSUSE
    sudo zypper install ./RClone.Manager-*.rpm
    ```

### Arch Linux (AUR)
Install easily via an AUR helper like `yay`:
```bash
# Stable Version
yay -S rclone-manager

# Git Version (Bleeding Edge)
yay -S rclone-manager-git

```

---

## 🧊 Method 3: Flatpak (Sandboxed)

Ideal for immutable systems like Fedora Silverblue, SteamOS, or VanillaOS.

```bash
flatpak install flathub io.github.zarestia_dev.rclone-manager

```

> **Note:** Flatpak apps are isolated. You might need [Flatseal](https://flathub.org/apps/com.github.tchx84.Flatseal) to manage permissions if you want to mount remotes or access the some certain folders. For more info check the **[Troubleshooting](https://github.com/Zarestia-Dev/rclone-manager/wiki/Troubleshooting-Linux)** guide.

---

## 🔌 Enable Mounting (FUSE 3)

To use the **Mount** feature (mounting cloud storage as a local folder), Linux requires **FUSE 3**.

### 1. Install FUSE

Most distros have this, but if missing:

* **Debian/Ubuntu:** `sudo apt install fuse3`
* **Fedora:** `sudo dnf install fuse3`
* **Arch:** `sudo pacman -S fuse3`

---

## 🛠 Troubleshooting

* **App won't launch?** Try running it from the terminal to see error logs.

For more issues, see the **[Troubleshooting](https://github.com/Zarestia-Dev/rclone-manager/wiki/Troubleshooting-Linux)** guide.
