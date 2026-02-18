# Troubleshooting - macOS

This page covers common issues and solutions specific to macOS users of RClone Manager.

## Common Issues

### "This app is damaged and can't be opened"

**Problem:** When trying to open RClone Manager, macOS displays an error message stating the app is damaged or can't be verified.

**Why This Happens:**

RClone Manager is not notarized or signed with an Apple Developer certificate. As a free and open-source project released under the GPL-3.0 (or later) license, we do not pay Apple's $99/year fee required for notarization. Because of this, macOS Gatekeeper may flag the app as "damaged" or block it from opening.

**Solution:**

Remove the quarantine attribute using Terminal:

```bash
# Navigate to Applications folder
cd /Applications

# Remove quarantine flag (replace with actual app name)
xattr -cr "RClone Manager.app"
```

Or if installed in a different location:

```bash
xattr -cr /path/to/RClone\ Manager.app
```

After running this command, macOS Gatekeeper will no longer block the application.

**Alternative Method:**

If the command above doesn't work, try opening via right-click:

1. Locate RClone Manager in Applications
2. Right-click (or Control+click) on the app
3. Select "Open" from the menu
4. Click "Open" again in the security dialog

This method may need to be repeated on first launch.

## Reporting Issues

When reporting macOS-specific issues, please include:

1. **macOS Version**: Check in About This Mac
   ```bash
   sw_vers
   ```

2. **Architecture**: Intel or Apple Silicon
   ```bash
   uname -m
   ```

3. **RClone Manager Version**: Check in app or:
   ```bash
   /Applications/RClone\ Manager.app/Contents/MacOS/rclone-manager --version
   ```

4. **Installation Method**: Homebrew, DMG, or other

5. **Error Messages**: Screenshots or console output

6. **Crash Logs**: From Console.app if applicable

## Future Plans

- **Notarization**: While we may consider Apple notarization in the future, it is not currently planned due to the associated costs
- **Open Source Commitment**: RClone Manager will remain completely free and open-source as long as development continues
- **Alternative Distribution**: Exploring alternative distribution methods that don't require Apple Developer Program membership

## Additional Resources

- [Installation - macOS](Installation-macOS) - Detailed installation guide
- [Configuration](Configuration) - General configuration guide
- [Desktop Configuration](Desktop-Configuration) - Desktop-specific features
- [GitHub Issues](https://github.com/Zarestia-Dev/rclone-manager/issues) - Report new issues
- [Discussions](https://github.com/Zarestia-Dev/rclone-manager/discussions) - Community support

## Community Solutions

Have you found a solution not listed here? Please share it on our [Discussions page](https://github.com/Zarestia-Dev/rclone-manager/discussions) to help other macOS users!

---

**Note**: macOS security policies change frequently. If you encounter issues not covered here, check the [GitHub Issues](https://github.com/Zarestia-Dev/rclone-manager/issues) for the latest workarounds.