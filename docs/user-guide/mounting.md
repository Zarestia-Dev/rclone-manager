# Mounting Remotes (The Illusion of Local Storage)

Mounting is the art of tricking your operating system into believing that your remote cloud storage is a physical hard drive plugged directly into your machine. It is highly convenient, occasionally temperamental, and absolutely essential for a seamless workflow.

This guide will instruct you on how to attach, configure, and safely detach your remotes using RClone Manager.

## 🗂️ Quick Navigation

* [Prerequisites (Read this first)](#%EF%B8%8F-prerequisites-the-reality-of-operating-systems)
* [Configuring a Mount (Quick Method)](#1-configuring-a-mount-during-setup-quick-remote-modal)
* [Configuring a Mount (Detailed / Advanced Method)](#2-detailed-remote-add-modal)
* [Monitoring the Mount Status](#3-overview-mount-status)
* [Editing an Existing Mount](#4-editing-configuration)

---

## ⚠️ Prerequisites: The Reality of Operating Systems

Before you attempt to mount anything, you must understand that your operating system is not magic. It requires drivers to understand virtual file systems. If you skip this step, RClone Manager will fail, and it will be your fault.

* **Windows:** You must install [WinFsp](https://winfsp.dev/). Without it, Windows will simply stare blankly at your mount request.
* **macOS:** You must install [macFUSE](https://osxfuse.github.io/).
* **Linux:** You need `fuse` or `fuse3` installed (e.g., `sudo apt install fuse3` or `sudo pacman -S fuse3`). Fortunately, this generally comes preinstalled on civilized distributions.

---

## 1. Configuring a Mount During Setup (Quick Remote Modal)

If you are adding a new remote via the **Quick Remote Modal**, you can establish its basic mount settings before the remote even finishes creating. Efficiency is key.

<p align="center">
<img height="500" alt="Quick Mount Config" src="https://github.com/user-attachments/assets/a8a4aac4-6dd3-4a78-80de-bd00eedb2e31" />
</p>

### 1.1 Enable Auto-Mount on Startup

RClone Manager can launch itself upon OS login (note: this master switch must first be enabled in your Global Preferences; default is disabled).

If you enable the **"Auto-Mount on Startup"** toggle for a specific remote, the application will attempt to mount it every time the app launches.

*Boundary Warning:* The app will only try *once* per startup. If Rclone encounters an error (like a dropped internet connection), it will not continuously bash its head against the wall trying to reconnect. You will have to trigger the mount manually once your network returns.

### 1.2 Source and Destination Paths

These paths dictate exactly what is being mounted and where it is going.

* **Source Path (The Cloud):** This is the path *inside* your remote. You don't have to mount the entire drive. If you only want your homework folder, you can specify `HomeWorks` (which translates to `YourRemote:HomeWorks`). Because the remote hasn't been fully created yet in this modal, you cannot browse for this path automatically. A small warning badge is there to remind you of this limitation.
* **Destination Path (Your Local Machine):** This is where the remote will manifest on your computer. You can type the path manually, or click the **Purple Folder Icon** to open your native file selector (or RClone Manager's built-in Nautilus browser if you are running in Headless Mode).

> [!NOTE]
> **A Windows Quirk:** On Windows, FUSE explicitly requires the destination folder to *not exist* prior to mounting. If you manually select an existing, empty folder as your destination, RClone Manager will quietly and politely delete that folder for you before executing the mount to satisfy Windows.

### 1.3 Immediate Execution

During the initial remote creation, if you have enabled auto-mount, RClone Manager will not wait for a system reboot to test it. The absolute millisecond the remote is successfully authenticated and created, the app will automatically trigger the mount operation.

---

## 2. Detailed Remote Add Modal

If you consider yourself an advanced user who requires multiple simultaneous mounts of the same remote, custom Rclone flags, or specific mount types, you must proceed to the **Detailed Remote Modal**.

<p align="center">
<img height="500" alt="Detailed Remote Modal" src="https://github.com/user-attachments/assets/f7375bbf-8e57-4b1c-8718-dfe4eded87a7" />
</p>

### 2.1 Mount Profiles

The first major upgrade here is the **Profiles Section**.

The initial profile is named `default`. You can edit its contents, but you cannot rename or delete the default profile itself. You can, however, create as many custom-named profiles as you wish.

<p align="center">
<img width="500" alt="Mount Profiles" src="https://github.com/user-attachments/assets/49a160f1-275b-4ee1-9418-c4ec8cee768b" />
</p>

These profiles allow you to fine-tune how Rclone behaves for specific mount instances by wiring them to different **VFS, Filter, and Backend Options**. You can attach multiple configurations to a single profile. If you do not wish to use them, simply leave them empty and Rclone will revert to its defaults.

Crucially, every profile acts independently. Changes made to one profile will not infect the others, allowing you to run vastly different mount configurations simultaneously.

### 2.2 Mount Type

The available mount types are dictated by Rclone and the specific FUSE implementation installed on your operating system. For instance, on a standard Arch Linux station, the options may look like this:

<p align="center">
<img width="500" alt="Mount Types" src="https://github.com/user-attachments/assets/f51d576b-2b67-4292-8ff5-b8a32fa7f320" />
</p>

Every Mount Type serves a different architectural purpose. You can consult the official Rclone documentation (or interrogate an AI) to determine the differences. If you do not know which one to select, simply **leave it empty**. Rclone will automatically select the best default method for your system. There is no need to overcomplicate things unnecessarily.

### 2.3 Mount Flags

Now we arrive at the truly advanced section: the raw Rclone mount flags.

<p align="center">
<img height="500" alt="Mount Flags" src="https://github.com/user-attachments/assets/f3085d92-4947-4baf-9724-185e7359a094" />
</p>

These fields represent the complete arsenal of mount flags supported by Rclone RC.

*Engineering Note:* These flags are not statically hardcoded into RClone Manager. They are dynamically fetched directly from Rclone RC as JSON data. This means when Rclone releases an update with brand new flags, RClone Manager will automatically support them without requiring an app update.

When you edit a value here, an **Orange Icon Button** will appear next to the input. This is your "Undo" button, allowing you to instantly reset the setting back to its factory default.

> [!NOTE]
> **Why is the Orange Button active on inputs I haven't touched?** > Because RClone Manager fetches these values dynamically via JSON, occasionally Rclone's internal reported value (e.g., `true`) does not perfectly match the UI's default placeholder (e.g., `null`). RClone Manager handles the vast majority of these discrepancies gracefully, but a few may slip through. Rest assured, this is purely a cosmetic quirk and will cause absolutely zero operational problems.

---

## 3. Overview Mount Status

Once your remote is successfully created and mounted, you will want to monitor it.

Navigate to your remote's details page. On the top title bar, you will see a series of centered buttons. The "Home" icon is selected by default. Next to it is a slightly unusual icon, I call it the "Mount Icon" (it looks somewhat like an NFC symbol). Click it.

<p align="center">
<img height="500" alt="Mount Overview UI" src="https://github.com/user-attachments/assets/0d5973d1-12a1-403d-bbb0-68a64a16846c" />
</p>

This is your dedicated Mount Control Panel. Let's expand it and review the contents:

<p align="center">
<img width="1500" alt="Mount Details Expanded" src="https://github.com/user-attachments/assets/80d1261a-5a4f-4bbc-8ba0-1749f40897b7" />
</p>

Here you can view the Source and Destination paths. If the remote is actively mounted, clicking the **folder icon** will immediately open the mounted path in your native file explorer. If the remote is unmounted, this icon will be disabled.

### The Storage Discrepancy

You may notice a Disk Usage indicator here. "Wait," you ask, "why is this usage different from the storage shown on the General remote page?"

Good eye.

* The **General Page** queries the *API* to show how much space your specific Rclone files are using.
* The **Mount Page** queries the *Local Path*. Therefore, it reflects the total capacity and usage of the entire cloud account. For example, on Google Drive, this Mount status will include the space eaten up by your Google Photos and Gmail, whereas the General tab will only show your Drive files.

### VFS Queue Monitoring

<p align="center">
<img width="1500" alt="VFS Queue" src="https://github.com/user-attachments/assets/675df481-52f5-4fd7-a759-4ba4266b1f26" />
</p>

Further down, you can monitor the **VFS Status**. When you drag and drop files into your mounted drive, Rclone does not upload them instantly. It places them into a queue based on your cache settings. This panel allows you to view that queue, reorder items, and manage the upload flow. (We will discuss VFS configurations in depth in a future section).

---

## 4. Editing Configuration

If you decide later that you want to alter your mount destination, add a specific flag, or change a cache setting, you do not need to delete the remote.

Click over to the **Configuration Tab**:

<p align="center">
<img height="500" alt="Configuration Tab" src="https://github.com/user-attachments/assets/619e31a7-4c48-4aae-a338-d3aaf0af3690" />
</p>

Here you will find your **Shared Configurations** (settings that apply to syncs and serves as well) and your specific **Mount Settings**. In this example, I have two profiles: `default` and `HomeWorks`.

Let's edit the `HomeWorks` profile by pressing the blue **"Edit Settings"** button.

<p align="center">
<img height="500" alt="Edit Settings Modal" src="https://github.com/user-attachments/assets/0a31d896-dc07-45f0-8c27-974da4076b18" />
</p>

As you can see, this is the exact same interface as the Detailed Remote Add modal, minus the top icon bar. You can adjust your Source paths, Destination paths, and flags here.

> [!WARNING]
> **Applying Changes:** If you edit the destination, source, or mount flags while the remote is currently active, the changes will *not* apply immediately. RClone Manager will not aggressively kill your active connection. You must manually stop the mount and restart it for the new configurations to take effect.

---

### Related Documentation

Now that your drive is mounted, you might want to automate some actual file transfers or configure caching.

* [Rclone Mount](https://rclone.org/commands/rclone_mount)
* [Sync and Transfer](https://github.com/Zarestia-Dev/rclone-manager/wiki/Sync-and-Transfer)
* [Troubleshooting](https://github.com/Zarestia-Dev/rclone-manager/wiki/Troubleshooting)