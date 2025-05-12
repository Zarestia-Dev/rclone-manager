# 🛠️ Issues

## 1️⃣ Terminal Window Flash on Windows

On **Windows**, you may notice a **brief terminal window flash** either:

* When **starting RClone Manager**, or
* When running certain RClone operations like **mounting remotes** or **OAuth authentication**.

### ❓ Cause

This is **not a bug in RClone Manager**, but a side effect of how the **official RClone binary** is compiled:

> ⚙️ **RClone is compiled as a console application using Go**, and on Windows, such binaries always open a terminal window when executed — even if launched from a GUI app.

#### ✅ What This Means

* The behavior is **harmless** and does **not affect functionality**.
* It is simply a side effect of **how RClone is compiled**, not something we directly control.

#### 🔮 Future Plans & Workarounds

We are actively looking into solutions to suppress the terminal window:

* ✨ **Build a GUI version of RClone**
  A custom RClone binary can be compiled with Go using:
  `go build -ldflags="-H windowsgui" -o rclone.exe`
  This prevents the terminal window from opening.

* 🤝 **Contribute upstream**
  We’re considering proposing a **pull request to the RClone project** to provide an optional “GUI mode” build target for better GUI integration.

Any approach will ensure full CLI compatibility is preserved.

---

## 2️⃣ Linux AppImage UI Lag

### 🐌 Description

On some **Linux** systems, the **UI performance** is noticeably **laggy** when running the AppImage. This issue is likely caused by how **frontend rendering** is handled in AppImage environments.

### ⚙️ Cause

This is likely due to **AppImage containerization**, which may affect UI responsiveness. The AppImage environment doesn't always interact optimally with GTK and other system resources, leading to slower performance.

#### 🔮 Future Plans

* Investigating ways to improve **frontend performance** within the AppImage.
* Potential switch to **different packaging methods** if performance doesn't improve.

---

## 3️⃣ No macOS Builds Yet

### 🚫 Description

Currently, there are **no macOS builds** for **RClone Manager**. We are targeting a future release for **macOS support**.

#### 🔮 Future Plans

* **macOS builds** are on the **roadmap** and will be added in future updates once thoroughly tested.

---

## 4️⃣ Missing Sync/Copy GUI

### 🔄 Description

The GUI for **syncing** or **copying** files between remotes using `rclone sync` or `rclone copy` is **currently not available**.

#### 🔮 Future Plans

* **Sync/Copy GUI** will be added in a **future version** (expected in **v0.2.0** or later).
