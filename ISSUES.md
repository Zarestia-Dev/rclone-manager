## 🛠️ Issues

### 1️⃣ Terminal Window Flash on Windows (FIXED)

🔗 [Track on GitHub Project](https://github.com/orgs/Zarestia-Dev/projects/2/views/1?pane=issue&itemId=135397576)  
(“Investigate workaround for terminal flash on Windows”)

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
