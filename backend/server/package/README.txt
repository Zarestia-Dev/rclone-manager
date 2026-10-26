RClone Manager Server v${VERSION}
================================
Web interface for managing Rclone from a browser. The executable embeds the UI,
translations and HTML templates; no other files are needed to run it.

Quick start
-----------
Linux / macOS:   chmod +x ./rclone-manager-server && ./rclone-manager-server
Windows:         .\rclone-manager-server.exe

Then open http://localhost:8080. Use --host 127.0.0.1 to listen only locally,
--user and --pass to require a login, and --tls-cert and --tls-key for HTTPS.
Run with --help for the complete list.

Updates
-------
When this executable is in a writable location owned by your user, the application
can update itself. Otherwise download the new archive and replace the executable. Settings, credentials and logs are stored outside the executable.

Linux service
-------------
rclone-manager-server.service is a systemd unit template. Edit the executable
path and credentials before installing it. It expects an rclone-manager user.

Requirements
------------
Linux: glibc 2.35+ and the D-Bus runtime library; FUSE for mounting.
Rclone itself is downloaded and managed by the application when needed.

Documentation: https://github.com/Zarestia-Dev/rclone-manager
License: see LICENSE
