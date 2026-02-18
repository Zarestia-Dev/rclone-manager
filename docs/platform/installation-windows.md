# Installation: Windows

RClone Manager supports **Windows 10** and **Windows 11** on both **x64** (Intel/AMD) and **ARM64** architectures.

Choose your preferred installation method below.

---

## ⚡ Method 1: Package Managers (Recommended)
The easiest way to install and keep the app updated is via a package manager.

### Winget (Official Windows Package Manager)
```powershell
winget install RClone-Manager.rclone-manager

```

### Chocolatey

```powershell
choco install rclone-manager

```

### Scoop

```powershell
scoop bucket add extras
scoop install rclone-manager

```

---

## 📥 Method 2: Manual Download

If you prefer a standard installer or portable version:

1. **Download:** Visit the **[Latest Releases Page](https://github.com/Zarestia-Dev/rclone-manager/releases)**.
2. **Choose your file:**
* `_setup.msi`: Microsoft installer (Recommended).
* `_setup.exe`: Standard installer.
* `_portable.zip`: No installation required, just unzip and run.


3. **Run the Installer:** Double-click the downloaded file.

### 🛡️ Microsoft SmartScreen Warning

Since this is an open-source application not signed with an expensive corporate certificate, you might see a "Windows protected your PC" popup.

1. Click **More info**.
2. Click **Run anyway**.

---

## 🔌 Enable Mounting (WinFsp)

To use the **Mount** feature (viewing cloud files as a local `Z:` drive), the app requires the **WinFsp** filesystem driver.

RClone Manager handles this automatically:

* **First Run Onboarding:** When you launch the app for the first time, it will scan your system. If WinFsp is missing, the setup wizard will offer to install it for you.
* **Auto-Repair:** If WinFsp is missing or gets uninstalled later, the app will detect this on startup and open a **Repair Sheet** to help you reinstall it quickly.

*(Optional) You can also download it manually from [winfsp.dev](https://winfsp.dev/)*.


## 🛠 Troubleshooting

* **App won't start?** Ensure you have [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) installed (pre-installed on Win 10/11).
* **Mounts not showing up?** Check if the drive letter is already taken by a USB stick or network drive.

For more issues, see the **[Troubleshooting](https://github.com/Zarestia-Dev/rclone-manager/wiki/Troubleshooting-Windows)** guide.