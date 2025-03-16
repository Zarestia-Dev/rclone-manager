# Rclone Manager

Rclone Manager is a **cross-platform (For Now Only Linux) GUI application** designed to help users **manage Rclone remotes** efficiently. Built using **Tauri and Angular**, it provides an intuitive interface for configuring, mounting, and managing cloud storage remotes via Rclone.

🚧 **This project is under heavy development.** Expect frequent updates and improvements.

## 🚀 Features
- **Add, Edit, and Remove Remotes** – Manage cloud storage configurations effortlessly.
- **Dynamic Remote Configurations** – Supports multiple remote types like Google Drive, AWS S3, OneDrive, Dropbox, and more.
- **Mount Management** – Mount and unmount remotes with **native execution** or **systemd-based mounting**.
- **Advanced Mount Options** – Configure cache settings, read chunk sizes, and other **VFS options** dynamically.
- **Tray Icon Support** – Quickly access mounted remotes from the system tray.
- **Dark & Light Mode** – Customizable UI themes.
- **Cross-Platform Support** – For now only Linux.

## 🛠️ Installation
### Prerequisites
- Install **Rclone** ([Download](https://rclone.org/downloads/))
- Ensure **Node.js (for Angular development)** and **Rust (for Tauri)** are installed.

### Build & Run
#### **Development Mode**
```bash
# Clone the repository
git clone https://gitlab.com/Hakanbaban53/rclone-manager.git
cd rclone-manager

# Install dependencies
npm install  # or npm install

# Run the Tauri app
npm run tauri dev  # or npm run dev
```
⚠️ **Note:** Running `npm run ng serve` to build only the Angular app will likely not work correctly. The app relies on **Tauri APIs** (e.g., for the custom title bar), which are not available when running Angular in standalone mode.

#### **Build for Production**
```bash
# Build the Tauri application
npm run tauri build  # or npm run tauri build
```

## 📖 Usage
1. **Add a new remote**: Click on `Add Remote`, select a storage provider, and enter the necessary credentials.
2. **Edit an existing remote**: Open the configuration modal and modify remote settings.
3. **Mount a remote**: Choose a mount type (`Native` or `Systemd`), configure options, and mount the storage.
4. **Manage mount options**: Use advanced VFS cache options to optimize performance.
5. **Access mounted files**: Open mounted storage locations from the system tray or file manager.

## 📸 Screenshots
🚀 *Soon*

## 📜 License
This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**. See [LICENSE](LICENSE) for details.

## 🤝 Contributing
Contributions are welcome! Feel free to submit issues, feature requests, or pull requests via GitLab.

## 📧 Contact
For questions or feedback, open an issue on [GitLab](https://gitlab.com/Hakanbaban53/rclone-manager).

