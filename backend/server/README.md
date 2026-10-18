# RClone Manager Server

Manage Rclone from your browser on a server, NAS, or another computer. The server
runs your transfers and automations; the browser provides the interface.

## Choose the right build

| Build                    | Use it when                                                            | Native desktop libraries       | Updating the application                                 |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| **Docker / pure server** | You want a background service on a server or NAS                       | No Tauri, GTK, WebKit, or Xvfb | Replace the container or server binary                   |
| **Server with tray**     | You want the web interface plus a local system tray and native updater | Required by Tauri              | Native updater where supported, or reinstall the package |
| **Desktop app**          | You want the interface in a local application window                   | Required by Tauri              | Native updater where supported, or reinstall the package |

The desktop executable is `rclone-manager`. The pure server is
`rclone-manager-server`; the tray-enabled server remains `rclone-manager-headless`.
Windows adds `.exe`.

Two independent workflows upload to the same `headless-v<version>` release:
`release-server.yml` builds Server executables; `release-headless.yml` builds
Server + Tray installers. A failure in one does not block the other.

- **Server:** `server-<os>-<arch>-<version>` (Linux/macOS) or
  `server-windows-<arch>-<version>.exe` (Windows). The executable embeds the UI,
  translations, and HTML templates. The same file is used for downloads and updates.
- **Server + Tray:** native installers named `rclone-manager-headless`.

Server executables target Linux, Windows, and macOS on x86_64 and aarch64.
Download the file for your operating system and processor. You can run it under its
downloaded name, or rename it to `rclone-manager-server` (`.exe` on Windows) to use
the commands and service template below. On Linux/macOS, grant execute permission
with `chmod +x ./rclone-manager-server`, then run `./rclone-manager-server`.
Linux executables require glibc 2.35+ and the D-Bus runtime library; mounting also
requires FUSE. They are not static binaries for Alpine/musl.
The Dockerfile builds the pure server. Existing published releases are unchanged.
See [platform TODOs](https://github.com/Zarestia-Dev/rclone-manager/blob/master/backend/TODO.md) for additional targets still under review.

## Quick start with Docker

```bash
docker run -d \
  --name rclone-manager \
  --restart=unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v rclone-config:/config \
  -v rclone-manager-data:/data \
  ghcr.io/zarestia-dev/rclone-manager:latest
```

Open `http://localhost:8080` on the Docker host. For access from another computer,
use `-p 8080:8080` and configure authentication and HTTPS as described in the
[configuration guide](https://hakanismail.info/zarestia/rclone-manager/docs/configuration-headless).

Keep both volumes when replacing the container:

- `/data`: application settings, credentials storage, and the downloaded Rclone binary.
- `/config`: Rclone's `rclone.conf`.

For a remote server, an SSH tunnel lets you keep the web port bound to localhost:

```bash
ssh -L 8080:127.0.0.1:8080 user@your-server
```

Then open `http://localhost:8080` on your computer. Cloud-provider OAuth can also
require forwarding port `53682`; see the configuration guide for Docker host
networking and manual `rclone authorize` alternatives.

## Build and run the pure server

Run these commands from the application repository root after installing the
[build prerequisites](https://hakanismail.info/zarestia/rclone-manager/docs/building):

```bash
npm ci
npm run build:server
./backend/target/release/rclone-manager-server --host 127.0.0.1 --port 8080
```

`npm run build:server` builds Angular, then compiles the release server with the
frontend embedded in the executable. For a direct `cargo build --release`, run
`npm run build` first; compilation fails if the frontend is missing.

Builds with `debug_assertions` enabled serve files from disk; builds without it
embed the frontend. This also applies to the server with a native tray.

For development, after building the frontend:

```bash
npm run dev:server -- --host 127.0.0.1 --port 8080
```

This runs the server through Cargo. Rebuild the frontend after UI changes; this
command does not start Angular's development server or enable automatic reload.

### Deploy outside the source checkout

The release executable includes the UI, translations, and HTML templates.
Copy the executable to the destination; no `browser/` or `i18n/` directory is needed.
Rclone requires filesystem paths for templates, so the application materializes
those templates in its cache directory when needed. Settings, credentials, logs,
and the separately managed Rclone binary remain outside the executable.

`core` is a shared Rust library, not another executable you need to launch.
For an explicit Cargo target, binaries are under
`backend/target/<target>/release/` instead of `backend/target/release/`.

### Server options

```bash
./rclone-manager-server \
  --host 127.0.0.1 \
  --port 8080 \
  --data-dir /path/to/app-data \
  --cache-dir /path/to/cache \
  --logs-dir /path/to/logs
```

Use `--user` and `--pass` together to enable authentication, and `--tls-cert` and
`--tls-key` together to enable HTTPS. Equivalent `RCLONE_MANAGER_*` environment
variables also work for standalone binaries. Run `--help` for the complete list.
The pure server has no `--tray` option and no native application auto-installer.

## Linux systemd service

A standalone server service template is provided in
[`linux/rclone-manager-server.service`](https://github.com/Zarestia-Dev/rclone-manager/blob/master/backend/server/linux/rclone-manager-server.service).
Edit its executable path and credentials for your installation, create the
`rclone-manager` service user, and install the executable before enabling it. This template uses the pure server and needs no desktop
session or virtual display.

## Build the server with a native tray

```bash
npm run dev:headless
npm run build:headless
```

These scripts select the Tauri application with `web-server,tray,updater`.
They do not build the pure server. On Linux, this variant needs the native GUI
runtime and a display environment. Use the pure server for a service without a
desktop session.

## Downloads and updates

- [GitHub releases](https://github.com/Zarestia-Dev/rclone-manager/releases): check the headless release description and its package requirements.
- [Container registry](https://github.com/Zarestia-Dev/rclone-manager/pkgs/container/rclone-manager): Docker images.
- [Installation guide](https://hakanismail.info/zarestia/rclone-manager/docs/installation-headless): deployment and service setup.

For Docker Compose deployments:

```bash
docker compose pull
docker compose up -d
```

For standalone deployments, stop the service, replace the binary, then restart it. Preserve your data,
configuration, and credential files. Rclone engine updates are separate from
updates to RClone Manager itself.
