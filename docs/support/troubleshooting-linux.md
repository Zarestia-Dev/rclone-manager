# 🐧 Troubleshooting on Linux

This page provides solutions to common issues you may encounter when running **RClone Manager** on Linux systems.

**Quick links to real issues:**

* [Issue 1: AppImage/Flatpak starts only in the top bar (WebKitGTK Bug)](https://github.com/Zarestia-Dev/rclone-manager/issues/13)
* [Issue 2: Permission Errors (Flatpak Sandbox)](https://github.com/Zarestia-Dev/rclone-manager/issues/52)

---

## 🧩 Issue 1: App Fails to Start or Freezes (WebKitGTK Compositing Bug)

This is one of the most frequently reported issues on Linux setups using **WebKitGTK**, which **RClone Manager** depends on via **Tauri**.

### 🧠 Symptoms

* Crashes at launch with:

  ```
  Failed to create GBM buffer of size 949x1023: Invalid argument
  ```
* Window appears **blank**, **transparent**, or **frozen**
* App hangs indefinitely with no visible UI

### ⚙️ Cause

The issue is caused by a **bug in WebKitGTK’s hardware-accelerated compositing mode**.
It is more common on **Wayland** (GNOME, Hyprland, Sway), but can also occur on **X11**, depending on GPU drivers.

> **Note:** Wayland is *not* the root cause. Crash happens because WebKitGTK fails to allocate GPU buffers correctly under certain configurations.

---

### 🧯 Solution: Disable GPU Compositing

#### Temporary Fix

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 rclone-manager
```

If that does not resolve the issue, force XWayland:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 GDK_BACKEND=x11 rclone-manager
```

---

### 💾 Permanent Fix

Choose the method based on your installation type:

---

#### 🖥️ System Install / AppImage / Native (.deb / .rpm)

1. Locate your `.desktop` file:

   * `/usr/share/applications/RClone Manager.desktop`
   * `~/.local/share/applications/RClone Manager.desktop`

2. Edit the file and modify the **Exec** line to:

```
Exec=env WEBKIT_DISABLE_COMPOSITING_MODE=1 rclone-manager
```

3. Save and restart the app from your launcher.

---

#### 📦 Flatpak

**Step 1 — Test first:**

```bash
flatpak run --env=WEBKIT_DISABLE_COMPOSITING_MODE=1 io.github.zarestia_dev.rclone-manager
```

**Step 2 — If it works, make it permanent:**

```bash
flatpak override --user --env=WEBKIT_DISABLE_COMPOSITING_MODE=1 io.github.zarestia_dev.rclone-manager
```

The fix will now apply automatically whenever you launch the app.

---

## 🔐 Issue 2: Permission Errors (Flatpak Security)

Flatpak uses strict sandboxing. **RClone Manager normally works without additional permissions**, but some features require extra access.

### 🧾 Permission Reference

| Permission                   | Description                                       | Required For                 |
| ---------------------------- | ------------------------------------------------- | ---------------------------- |
| `org.freedesktop.Flatpak`    | Allows talking to the Flatpak host service        | Mount operations             |
| `~/.config/autostart:create` | Allows creating autostart entries                 | “Start on login” feature     |
| `home`                       | Grants access to the user’s entire home directory | Mounting anywhere in `$HOME` |

**Note:**
* **Restart Required:** You must close and reopen the application after granting or changing permissions for them to take effect.
* **Reconfiguration:** After granting specific path permissions, you may need to reconfigure your paths in Rclone Manager. The application initially accessed locations through Flatpak's sandboxed portal paths (temporary virtual paths). Once you grant direct filesystem permissions, these portal paths are replaced with actual system paths, and the previous temporary paths become invalid.
---

## ⚙️ Granting Permissions

Choose the method you prefer:

---

### 🖥️ Method A: Flatseal (GUI — Recommended)

**1. Install Flatseal:**

```bash
flatpak install flathub com.github.tchx84.Flatseal
```

**2. Open Flatseal → Select “RClone Manager”**

* **For mount operations:**
  Go to **Session Bus → Talk**
  Add:

  ```
  org.freedesktop.Flatpak
  ```

* **For startup on login:**
  Go to **Filesystem**
  Add:

  ```
  ~/.config/autostart:create
  ```

* **For full home access (optional):**
  Add:

  ```
  home
  ```

**3. Restart the app**

---

### 💻 Method B: Command Line

**Mount operations:**

```bash
flatpak override --user io.github.zarestia_dev.rclone-manager \
  --talk-name=org.freedesktop.Flatpak
```

**Autostart permissions:**

```bash
flatpak override --user io.github.zarestia_dev.rclone-manager \
  --filesystem=~/.config/autostart:create
```

**Mount anywhere in $HOME (broader access):**

```bash
flatpak override --user io.github.zarestia_dev.rclone-manager \
  --filesystem=home
```

> **📝 Security Note:**
> `--filesystem=home` grants full read/write access to your user’s home directory.
> Only use it if you need to mount folders outside Documents/Downloads or other specifically granted paths.

---

### 🔍 Verify Your Overrides

```bash
flatpak override --user --show io.github.zarestia_dev.rclone-manager
```

Look for:

* `org.freedesktop.Flatpak` in **Session Bus Policy**
* `~/.config/autostart:create` or `home` under **Filesystem Access**

---

## 🚫 Issue 3: Fusermount Error (allow_other)

This issue occurs when you try to use the `--allow-other` flag (e.g., to share mounts with Docker, Plex, or other users) but your system is not configured to allow it.

### 🧠 Symptoms

* Mounting fails with an error log similar to:
```
fusermount: option allow_other only allowed if 'user_allow_other' is set in /etc/fuse.conf
```

### ⚙️ Cause

This is a **Linux system security feature**, not a bug in RClone Manager. By default, standard users are not allowed to mount file systems that other users (including root or system services) can access.

### 🧯 Solution: Edit Fuse Configuration

You need to enable the `user_allow_other` option in your system's FUSE configuration.

1. Open the configuration file with a text editor (requires sudo/root):
```bash
sudo nano /etc/fuse.conf
```


2. Look for the line that says `#user_allow_other`.
3. **Uncomment it** by removing the `#` at the start, so it looks like this:
```conf
user_allow_other
```

4. Save the file (`Ctrl+O`, `Enter`) and exit (`Ctrl+X`).
5. Try mounting again in RClone Manager. No restart is usually required.

### 🧯 Solution when running Headless (Docker)

You need to enable the `user_allow_other` option in the Docker container' FUSE configuration.

1. Create a fuse.conf file somewhere in your home directory (or anywhere really):
```bash
sudo nano $HOME/fuse.conf
```

2. Add a single line in that file:
```conf
user_allow_other
```

4. Save the file (`Ctrl+O`, `Enter`) and exit (`Ctrl+X`).

5. Change the command you use to run the Docker container, to mount this new file as `/etc/fuse.conf`:

```bash
docker run ... -v /home/you/fuse.conf:/etc/fuse.conf ...
```

---

## 📚 Need More Help?

If issues persist:

* Check the **[GitHub Issues](https://github.com/zarestia-dev/rclone-manager/issues)**
* When reporting bugs, include:
  * Linux distribution
  * Desktop environment (GNOME, KDE, Hyprland…)
  * GPU + drivers
  * Installation method (native / AppImage / Flatpak)
