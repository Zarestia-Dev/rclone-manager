RClone Manager Server v${VERSION}
================================
The executable embeds the web UI; no other files are needed to run it.

Linux / macOS:   ./rclone-manager-server
Windows:         .\rclone-manager-server.exe

Then open http://localhost:8080. Run with --help for the available options
(host, port, authentication, HTTPS).

rclone-manager-server.service (Linux only) is a systemd unit template. Its first
lines show how to install the executable under /opt/rclone-manager, owned by the
service user, which lets the application update itself.

Documentation and requirements:
https://github.com/Zarestia-Dev/rclone-manager
