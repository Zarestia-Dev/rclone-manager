# Frequently Asked Questions

Welcome to the RClone Manager FAQ! Find answers to common questions about installation, configuration, usage, and troubleshooting.

---

## 📦 Installation

### What is RClone Manager?
**Category:** features  
**Tags:** overview, introduction

RClone Manager is a modern, user-friendly desktop application that provides a graphical interface for rclone. It allows you to easily manage cloud storage providers, sync files, mount remotes, and perform various cloud operations without using command-line interfaces.

### What platforms does RClone Manager support?
**Category:** installation  
**Tags:** platforms, compatibility

RClone Manager supports Windows 10/11 (x64 and ARM64), macOS 10.15+ (Intel and Apple Silicon), and modern Linux distributions (x64 and ARM64). We provide installers, AppImages, and packages for different platforms.

### Why does macOS show RClone Manager as “damaged” or block it from opening?
**Category:** installation
**Tags:** macOS, Gatekeeper, notarization

Currently, **RClone Manager is not notarized or signed with an Apple developer certificate**. Since this is a free and open-source project released under the **GPL-3 (or later)** license, we do not pay the **$99/year fee** that Apple requires for notarization.

Because of this, **macOS Gatekeeper** may show the app as “damaged” or prevent it from opening.

### How do I install RClone Manager?
**Category:** installation  
**Tags:** installation, setup

Download the appropriate installer for your platform from our Downloads page. For Windows, use the MSI installer. For macOS, download the DMG file. For Linux, you can use the AppImage, DEB package, or RPM package depending on your distribution. Detailed installation instructions are available in our documentation.

### Do I need to install rclone separately?
**Category:** installation  
**Tags:** rclone, dependency

No, RClone Manager includes rclone as a bundled dependency. However, you can also use your own rclone installation by specifying the path in the settings if preferred.

### What are the system requirements?
**Category:** installation  
**Tags:** requirements, system, hardware

RClone Manager requires a minimum of 4GB RAM and 100MB disk space. For Windows: Windows 10 version 1903 or later. For macOS: macOS 10.15 (Catalina) or later. For Linux: Any modern distribution with desktop environment support.

---

## ⚙️ Configuration

### How do I set up my first cloud remote?
**Category:** configuration  
**Tags:** setup, remote, cloud

After launching RClone Manager, click "Add Remote" and follow the setup wizard. You'll select your cloud provider (Google Drive, Dropbox, OneDrive, etc.), authenticate with your account, and configure the settings. The app will guide you through the OAuth process for supported providers.

### Where is my configuration stored?
**Category:** configuration  
**Tags:** config, location, storage

RClone Manager stores configuration in the standard rclone config file location. You can also specify a custom config file path in settings. The app supports encrypted config files for added security.

### How do I encrypt my cloud storage?
**Category:** configuration  
**Tags:** encryption, security, crypt

RClone Manager supports rclone's crypt functionality. You can create an encrypted remote that wraps around your existing cloud storage remote. This provides client-side encryption, ensuring your files are encrypted before being uploaded to the cloud.

### Can I use multiple accounts for the same provider?
**Category:** configuration  
**Tags:** multiple, accounts, remotes

Yes, you can configure multiple remotes for the same cloud provider using different accounts. Each remote will have its own configuration and authentication. This is useful for separating personal and work accounts.

---

## 🚀 Usage

### What's the difference between Sync and Copy?
**Category:** usage  
**Tags:** sync, copy, operations

Copy transfers files from source to destination without deleting anything. Sync makes the destination identical to the source by copying new/changed files and deleting files that don't exist in the source. Use Copy for backups, Sync for mirroring.

### How do I mount a remote as a drive?
**Category:** usage  
**Tags:** mount, drive, vfs

Select your configured remote and click "Mount". Choose a mount point (drive letter on Windows, directory on Linux/macOS) and configure VFS options as needed. The remote will appear as a local drive that you can access through your file manager.

---

## ✨ Features

### Which cloud storage providers are supported?
**Category:** features  
**Tags:** providers, cloud, storage

RClone Manager supports all cloud providers that rclone supports, including Google Drive, Dropbox, OneDrive, Amazon S3, Box, pCloud, MEGA, FTP, SFTP, and many more. The full list includes over 40 different storage providers.

### Can I limit bandwidth usage?
**Category:** features  
**Tags:** bandwidth, limit, performance

Yes, RClone Manager includes bandwidth limiting options. You can set upload and download limits globally in settings or per-operation. This is useful for preventing the app from consuming all your internet bandwidth.

### Does RClone Manager auto-update?
**Category:** features  
**Tags:** updates, auto-update, version

Yes, RClone Manager includes built-in auto-update functionality using Tauri's updater. You'll be notified when updates are available and can choose when to install them. You can also check for updates manually in the About section.

### Is RClone Manager open source?
**Category:** features  
**Tags:** open-source, github, community

Yes, RClone Manager is completely open source. You can view the source code, contribute to development, report issues, and suggest features on our GitHub repository. We welcome community contributions and feedback.

---

## 🔧 Troubleshooting

### I'm having connection issues with my remote
**Category:** troubleshooting  
**Tags:** connection, network, auth

First, check your internet connection and ensure the cloud provider's service is operational. Try refreshing your authentication tokens by going to the remote settings. Check firewall settings and proxy configuration if applicable. If issues persist, check our troubleshooting guide.

### Transfers are slow, how can I improve performance?
**Category:** troubleshooting  
**Tags:** performance, speed, optimization

Try adjusting the number of transfer threads in settings, check your bandwidth limits, ensure you have sufficient disk space, and verify your network connection. For cloud providers, check if you're hitting API rate limits. VFS cache settings can also affect mount performance.

---

## 🆘 Getting Help

If you can't find the answer to your question here, try these resources:

- **[GitHub Discussions](https://github.com/RClone-Manager/rclone-manager/discussions)** - Ask questions and get community help
- **[Report Issues](https://github.com/RClone-Manager/rclone-manager/issues)** - Found a bug? Report it here
- **[Documentation](https://github.com/RClone-Manager/rclone-manager/wiki)** - Comprehensive guides and tutorials
- **[rclone Documentation](https://rclone.org/docs/)** - Official rclone documentation for advanced features
