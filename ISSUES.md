## 🛠️ Issues
### 1️⃣ Terminal Window Flash on Windows

On **Windows**, you may see a **brief terminal window flash** either:

- When **starting Rclone Manager**, or
- When running certain Rclone operations like **mounting remotes** or **OAuth authentication**.

This is **not a bug in Rclone Manager**, but a side effect of how the **official Rclone binary** is compiled:

> ⚙️ **Rclone is compiled as a console application using Go**, and on Windows, such binaries always open a terminal window when executed — even if launched from a GUI app.

#### ✅ What This Means

- This behavior is **harmless** and does **not affect** functionality.
- It is simply a side effect of **how Rclone is compiled**, not something we directly control.

#### 🔮 Future Plans & Workarounds

We are actively looking into solutions to suppress the terminal window:

- ✨ **Build a GUI version of Rclone**
  A custom Rclone binary can be compiled with Go using:
  `go build -ldflags="-H windowsgui" -o rclone.exe`
  This prevents the terminal window from opening.

- 🤝 **Contribute upstream**
  We’re considering proposing a **pull request to the Rclone project** to provide an optional “GUI mode” build target for better GUI integration.

Any approach will ensure full CLI compatibility is preserved.