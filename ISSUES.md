## 🛠️ Issues

### 1️⃣ Terminal Window Flash on Windows

🔗 [Track on GitHub Project](https://github.com/users/Hakanbaban53/projects/6/views/1?pane=issue&itemId=110319862)  
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

### 2️⃣ Linux: Sleep Inhibition with Mounted Remotes

On some Linux systems (e.g., GNOME desktop), it has been observed that after mounting a remote, the system may be prevented from sleeping or suspending. It is unclear if this is caused by RClone Manager, the file manager, or another process.

#### 🐧 User Observations

- After mounting a remote, the system sometimes does not enter sleep mode as expected.
- Using `gdbus` to inspect session inhibitors:

  ```sh
  gdbus call --session \
    --dest org.gnome.SessionManager \
    --object-path /org/gnome/SessionManager \
    --method org.gnome.SessionManager.GetInhibitors
  # ([objectpath '/org/gnome/SessionManager/Inhibitor754'],)
  ```

- Attempts to query specific inhibitors;

  ```sh
  gdbus call --session \
    --dest org.gnome.SessionManager \
    --object-path /org/gnome/SessionManager \
    --method org.gnome.SessionManager.GetInhibitors
  # ([objectpath '/org/gnome/SessionManager/Inhibitor754'],)

  gdbus call --session \
    --dest org.gnome.SessionManager \
    --object-path /org/gnome/SessionManager/Inhibitor754 \
    --method org.gnome.SessionManager.Inhibitor.GetFlags
  # (uint32 5,)

  gdbus call --session \
    --dest org.gnome.SessionManager \
    --object-path /org/gnome/SessionManager/Inhibitor754 \
    --method org.gnome.SessionManager.Inhibitor.GetAppId
  # ('org.gnome.Nautilus',)

  gdbus call --session \
    --dest org.gnome.SessionManager \
    --object-path /org/gnome/SessionManager/Inhibitor754 \
    --method org.gnome.SessionManager.Inhibitor.GetClientId
  # Error: GDBus.Error:org.gnome.SessionManager.Inhibitor.NotSet: Value is not set

  gdbus call --session \
    --dest org.gnome.SessionManager \
    --object-path /org/gnome/SessionManager/Inhibitor754 \
    --method org.gnome.SessionManager.Inhibitor.GetReason
  # ('Copying Files',)
  ```

  In this case, the inhibitor is set by `org.gnome.Nautilus` (the GNOME Files app), with the reason "Copying Files". This suggests the file manager may be responsible for sleep inhibition when interacting with mounted remotes.

#### ❓ Status

- Currently, the app does not appear to directly inhibit sleep.
- The cause may be related to the file manager or how the remote is mounted.
- Further investigation is needed to determine if this is an upstream issue or if RClone Manager can/should handle sleep inhibition explicitly.

If you experience this issue, please provide details about your Linux distribution, desktop environment, and steps to reproduce.

---

> **Note:**
> It is currently unclear whether this sleep inhibition is caused by RClone Manager, the file manager, or another process involved in mounting and accessing remotes. Any help, insights, or suggestions from the community are appreciated! If you have encountered similar issues or have ideas for troubleshooting, please comment or open an issue.
