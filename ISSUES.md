## 🛠️ Issues

### 1️⃣ Terminal Window Flash on Windows (I think the fix is using tauri shell api to run rclone commands)

🔗 [Track on GitHub Project](https://github.com/users/RClone-Manger/projects/6/views/1?pane=issue&itemId=110319862)  
(“Investigate workaround for terminal flash on Windows”)

On **Windows**, you may see a **brief terminal window flash** either:

- When **starting RClone Manager**, or
- When running certain Rclone operations like **mounting remotes** or **OAuth authentication**.

This is **not a bug in RClone Manager**, but a side effect of how the **official Rclone binary** is compiled:

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

### 2️⃣ macOS: This app is broken and can't run

On newer versions of macOS ARM and x86, currently, RClone Manager is not notarized or signed with an Apple developer certificate. Since this is a free and open-source project released under the GPL-3 (or later) license, we do not pay the $99/year fee that Apple requires for notarization.

#### ✅ What This Means

- Because of this, macOS Gatekeeper may show the app as “damaged” or block it from opening.
- In the future, we may consider notarization, but for now it is not planned.

#### 🔮 Future Plans & Workarounds

- Work around is run Terminal and cd to Applications folder run xattr -c rclonemanager.app
- Running that command will bypass macOS gatekeeper quarantine and allow for rclonemanager to run.
- In the future, we may consider notarization, but for now it is not planned.
- Also, this app will remain completely free and open-source as long as I continue development.
