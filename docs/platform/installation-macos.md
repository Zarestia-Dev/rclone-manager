# Installation: macOS

Welcome to the macOS installation guide for **RClone Manager**

RClone Manager supports both **Intel** and **Apple Silicon (M-Series)** Macs natively.

> **Note:** RClone Manager is an open-source community project. Since it is not notarized by Apple, you will likely see security warnings. This is normal for open-source software not distributed via the App Store.

---

## 🚀 Method 1: Direct Download (Recommended)

### 1. Download
Visit the **[Latest Releases Page](https://github.com/Zarestia-Dev/rclone-manager/releases)**.
* **Recommended:** Download the `.dmg` file.
* **Alternative:** You can also download the `.app.tar.gz` archive.

### 2. Install
**If you downloaded the `.dmg`:**
1.  Open the downloaded file.
2.  Drag the **RClone Manager** icon into the **Applications** folder.

**If you downloaded the `.app.tar.gz`:**
1.  Double-click the file to extract it.
2.  Drag the extracted **RClone Manager.app** into your **Applications** folder.

### 3. Open & Bypass Security
When you open the app for the first time, you might see a message saying **"App is damaged and can't be opened"** or **"Unidentified Developer"**.

**Option A: Right-click (Easiest)**
1.  Go to your **Applications** folder.
2.  **Right-click** (or Control+Click) on RClone Manager.
3.  Select **Open**.
4.  Click **Open** in the confirmation dialog.

**Option B: Terminal (The "Damaged" Fix)**
If Option A doesn't work and macOS claims the app is "damaged" (a common Gatekeeper issue), run this command in Terminal to clear the quarantine flag:

```zsh
xattr -cr /Applications/RClone\ Manager.app

```

---

## 🍺 Method 2: Homebrew (Coming Soon)

*We are working on adding RClone Manager to Homebrew. Once approved, you will be able to install it via:*

```sh
brew install --cask rclone-manager

```

*For now, please use the Direct Download method.*

---

## 🔌 Enable Mounting (macFUSE)

To use the **Mount** feature (mounting cloud storage as a local drive/volume), macOS requires **macFUSE**.

1. **Check:** The app will detect if FUSE is missing during the onboarding or via the repair sheet.
2. **Install:** Due to Apple's strict security regarding system extensions, you may need to install this manually.
* Download from: [osxfuse.github.io](https://osxfuse.github.io/)
* **Important:** After installing, go to **System Settings > Privacy & Security** and allow the system extension if prompted. You may need to restart your Mac.



---

## 💡 Verification & Source

* **Verify:** SHA256 checksums are available on the release page if you wish to verify your download.
* **Source:** You can inspect the code or build it yourself from the [GitHub Repository](https://github.com/Zarestia-Dev/rclone-manager).

---

## 🛠 Troubleshooting

* **"App is damaged":** Use the `xattr -cr` command mentioned in Method 1.
* **Mounts fail:** Ensure macFUSE is installed and permitted in System Settings.

For more help, see the **[Troubleshooting](https://github.com/Zarestia-Dev/rclone-manager/wiki/Troubleshooting-macOS)** guide.