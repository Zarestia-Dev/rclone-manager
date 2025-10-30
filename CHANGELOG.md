# Changelog
# All notable changes to this project will be documented in this file.

## [v0.1.5] - 2025-10-30
### Added
- Added a Backend Settings modal. You can now set the backend options globally for all remotes. If you wants to override the backend options for a specific remote, you can do it in the remote settings. (e.g. mount options, vfs options, etc.). Also added the export and import feature for the backend settings on export modal.
- New Backend flag support for remotes. You can now set backend flags for remotes in the remote settings. This will be applied to all operations for that remote.
- Added Filter options support for mounts. You can now set filter options for mounts in the remote settings. This will be applied to the mount operation for that remote.
- Added system theme detection support. You can now set the theme to system in the settings. It will automatically change the theme based on the system theme.
- Interactive mode toggle added to Quick Add Remote modal to. Now you can enable or disable the interactive mode for remotes that require additional configuration steps (like iCloud, OneDrive, etc.). By default, it is enabled for those remotes.
- Quick Add Remote modal design has been improved for better user experience and usability.

### Changed
- Password Manager modal has been removed. Now the password manager is integrated into the Backend Settings modal. You can manage your passwords in the Backend Settings modal.
- Some npm and cargo dependencies have been updated to their latest versions.
- Detailed Remote Modal UI and behavior has been improved for better user experience and usability. Also its now filters the displayed fields based on the provider type of the remote (e.g., S3 specific fields for AWS or Alibaba Cloud providers not show the all provider fields anymore. Only relevant fields are displayed).
- Removed the json editor for remote adding and editing. Now only the form-based configuration is available for better user experience and usability.

### Fixed
- Fixed an issue where the RClone Manager Logo was not displayed correctly in the app.
- When one modal opens, disable the open other modals via shortcuts or other ways (Unlimited modal opening). This include the Onboard state too. (This not include the dialog modals like delete confirmation, etc.)
- Strip `RulesOpt.` prefix from rule fields before sending to rclone (e.g. `RulesOpt.ExcludeFrom` -> `ExcludeFrom`), which fixes issues where rclone ignored prefixed field names.
- Fixed an issue where the remotes not showing correctly in the tray menu.
- Fixed terminal window flash on Windows (brief terminal/console window appearing) when starting the app or running rclone operations.



## [0.1.4] - 2025-10-13
### Added
- Added a rclone beta update checker support. It will check for the latest beta version of rclone and notify the user if a new beta version is available. (Default Stable channel is selected. You can change it in the About modal > About Rclone section.)

### Changed
- Removed the rclone update modal and update badge. Now the update status is shown in the About modal > About Rclone section.

### Fixed
- Fixed a crash on Linux systems without NetworkManager by adding graceful error handling for metered network checks.


## [0.1.3-beta] - 2025-09-30
### Warning
- In this version, app identifier has been changed from `com.rclone-manager.app` to `com.rclone.manager` because of potential conflicts with MacOS application bundle extension. If you are updating from a previous version, please uninstall the old version first to avoid any conflicts. This change is necessary to ensure proper functionality and avoid issues with application recognition on MacOS. We apologize for any inconvenience this may cause and appreciate your understanding. You can export your configuration via the export feature before uninstalling the old version.

### Added
- **Auto-update support** using Tauri's built-in updater plugin. The application can now check for updates and install them with user permission. Additionally, users can install a previous version if it appears in the update section—this is typically offered as a fallback if a newer version has issues. Also with the new update system, bug fixes and improvements can be delivered more frequently (You're not waiting a 3 months anymore :D).

- Support for ARM architecture (Linux and Windows). The application can now run on ARM-based systems, such as Raspberry Pi and ARM-based Windows devices.

- Native console support for the native terminal. You can now open the remote configuration in the native terminal by clicking the "Remote Terminal" button in the top left add button. It will use the preferred terminal app from the settings. Also, you can set the preferred terminal app in the settings.

- **Encrypted configuration file support**: Added comprehensive support for rclone encrypted configuration files.
  - Automatic detection of encrypted config files
  - Secure password storage using system keyring/credential store
  - Encrypt/decrypt configuration operations

- Implemented the `bisync` and `move` operations for remotes.
  - Bisync: This operation synchronizes two remotes in both directions, ensuring that changes made in either remote are reflected in the other.
  - Move: This operation moves files from one remote to another, effectively transferring data without leaving duplicates.
- Added other configs for operations. (e.g. mountType, createEmptySrcDirs etc.)
- Added the `mountType` option for the mount type selection. It can be set to `mount`, `mount2`, or `NfsMount`. This types comes from the Rclone API. Default is `mount` (API handle this automatically).

- Added primary action selection - choose up to 3 preferred actions (mount/sync/copy/etc.) per remote for quick access and overview visibility. You can select and deselect actions in the remote general details view. This also affects the tray menu.

- Added interactive config support to Detailed Remote Modal. So we can make the post remote configuration. (Like Microsoft OneDrive)

### Changed
- Updated the Angular version to the latest stable version. Version 20.3.0

### Need Fix
- After engine restart, need the apply the startup settings again. (e.g. config file path, bw limit, etc.) (All Fixed)
- Remote updates not working properly. When you update a some settings to default, it does not update the remote. I know whats the problem. (Fixed)

## [beta-0.1.2] - 2025-07-15
### Added
- General tab added.
- Remote Clone feature added. Under the remote detail ellipsis button (Clones a remote with settings to new remote.).
- Rclone pid watcher feature added with instant stop Rclone process functionality. Also listens for changes in the rclone process state and updates the UI accordingly. You can find it in `About RClone Manager > About Rclone`  (I see the core/pid rcd command and I want to make something for it. IDK why but I did it.)
- Detecting the metered connection and showing a warning banner (Linux needed Network Manager. Its `nmcli` command is used to check for metered connections). Not supported on macOS because it does not support metered network detection (For now, it is only show the warning banner.).
- Watcher for mounted remotes added. It will automatically unmount the remote if it is not mounted anymore. It will also update the UI accordingly (5 seconds interval). You can also force check the mounted remotes by this Shortcut: Ctrl + Shift + M.
- Linting and formatting scripts added for the frontend and backend. It uses ESLint, Prettier, Clippy, and Rustfmt.
- Rclone update check feature added. It will check for the latest version of Rclone. Under the `About RClone Manager > About Rclone` section, you can find the update status and the update button.
- Rclone binary location selection feature added. You can select the Rclone binary location in the settings, onboard and the repair sheet. It will be used for the Rclone operations. If you don't select it, it will use the default location.

### Changed
- UI design has been improved.
- Mount path selection not forced to select a path from the file browser anymore. You can also type the path manually but it will be validated. Also added support for AllowNonEmpty option in the mount step. This allows you to mount a remote to a non-empty folder if its true.
- Onboarding process has been improved.
- Frontend and backend services have been refactored to use a more modular approach.


## [beta-0.1.1] - 2025-04-06
### Added
- MacOS support added
- Single instance support added
- MacOS mount plugin installer support implemented
- Remote root path selection added (That will be active after remote added)
- Remote Operations added: Sync and Copy  feature added (Syncs or copies remote with local folder, remote with remote or local with remote (if you want to copy local to local its working too. Idk why you would do that but it works))
- Bandwidth limit feature added (Limits the bandwidth for remote operations)
- Support for custom rclone config file location added
- Restrict visibility of the some tokens in the UI (like client secret, access token, etc.). It can be configured in the settings. (default is enabled)

### Fixed
- In the tray icon, the "Show App" option now correctly opens the app window. (Fixed)
- Rclone Configuration file is now correctly exported and imported.
- Fixed the issue where the application would not close when it could not find the rclone binary file.

### Changed
- Updated the cargo dependencies to the latest versions.
- Updated the npm dependencies to the latest versions.

## [beta-0.1.0] - 2024-12-05
### Added
- Added a new feature to manage remotes with a user-friendly interface.
- GTK-themed Angular frontend
- Tauri backend
- Basic remote management (add/edit/delete)
- Exporting and importing configurations
- Mounting and unmounting remotes
- File browser for mounted remotes
- OAuth support for OAuth2 providers
- VFS options
- Tray icon support
- Light/dark mode
- Cross-platform (Linux and Windows-ready, macOS coming soon)