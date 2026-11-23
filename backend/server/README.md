# RClone Manager Server

Manage Rclone from your browser on a server, NAS, or another computer. The server
runs your transfers and automations; the browser provides the interface.

## Choose the right build

| Build                    | Use it when                                                    | Native desktop libraries     | Updating the application                   |
| ------------------------ | -------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| **Docker / pure server** | You want a background service on a server or NAS               | None                         | In-app for the ZIP; pull the Docker image  |
| **Server packages**      | You want the web interface on your desktop, with a system tray | None (no GTK, WebKit or X11) | In-app: installs the new DEB, RPM or setup |
| **Desktop app**          | You want the interface in a local application window           | Required by Tauri            | Native updater where supported             |

The desktop executable is `rclone-manager`. The server is `rclone-manager-server`
in the ZIPs and the packages; Windows adds `.exe`. On Linux and Windows it shows a
system tray whenever a desktop session is there to show it; macOS builds have no
tray. The server replaces the RClone Manager Headless app (0.3.6 and older); see
[Moving from RClone Manager Headless](#moving-from-rclone-manager-headless).

`release-headless.yml` builds everything in the `headless-v<version>` release:

- **Server:** `server-<os>-<arch>-<version>.zip`. It contains the
  `rclone-manager-server` executable (`.exe` on Windows), `LICENSE`, a short
  `README.txt` and, on Linux, the systemd service template. The executable embeds
  the UI, translations, and HTML templates. The same ZIP is used for downloads and
  updates; the updater extracts only the executable.
- **Server packages:** `RClone.Manager.Server_<version>_<amd64|arm64>.deb`,
  `RClone.Manager.Server-<version>-1.<x86_64|aarch64>.rpm` and
  `RClone.Manager.Server_<version>_<x64|arm64>-setup.exe` (per user, no
  administrator rights) or `RClone.Manager.Server_<version>_<x64|arm64>_en-US.msi`
  (for all users; installing and every update ask for administrator approval).
  The tray shows over D-Bus on Linux and needs no other library; without a desktop
  session the server runs without it. The DEB and RPM update through `pkexec`,
  which asks for the administrator password in the desktop session.

Server packages target Linux, Windows, and macOS on x86_64 and aarch64.
Download the ZIP for your operating system and processor, extract it, and run
`./rclone-manager-server` (`.\rclone-manager-server.exe` on Windows).
Linux executables require glibc 2.35+ and the D-Bus runtime library; mounting also
requires FUSE. They are not static binaries for Alpine/musl.
The Dockerfile builds the pure server.
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

Then open `http://localhost:8080` on your computer.

Cloud-provider OAuth is different: Rclone's callback server listens on
`127.0.0.1:53682` inside the container, so `-p 53682:53682` cannot reach it. Either:

- run the container with `--network host` and also forward the callback port,
  `ssh -L 8080:127.0.0.1:8080 -L 53682:127.0.0.1:53682 user@your-server`, or
- answer **No** to "Use web browser to automatically authenticate?" while creating
  the remote, run the `rclone authorize "<provider>"` command it shows on a machine
  with a browser, and paste the resulting token back.

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
embed the frontend.

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
Prefer `RCLONE_MANAGER_PASS` over `--pass`: command-line arguments are visible to
other users in the process list. Repeated wrong passwords are slowed down; the
correct password is never delayed.
The server has no `--tray` option and no Tauri updater. It updates itself from
the signed release ZIP when its executable and directory belong to the user running it.

### Uploads and reverse proxies

Files uploaded from the browser are staged in `<cache-dir>/uploads` and removed
when the transfer ends, so the cache directory needs room for your largest upload.
The upload request stays open until the transfer to the remote has finished. Behind
a reverse proxy, raise the request-body limit and the read timeout (for nginx:
`client_max_body_size 0;`, `proxy_request_buffering off;` and a long
`proxy_read_timeout`), or large uploads fail in the browser while the transfer
carries on.

## Linux systemd service

A standalone server service template is provided in
[`linux/rclone-manager-server.service`](https://github.com/Zarestia-Dev/rclone-manager/blob/master/backend/server/linux/rclone-manager-server.service).
The commands at the top of the file create the `rclone-manager` service user and
install the executable under `/opt/rclone-manager`, owned by that user, so the
application can update itself. An executable owned by root (for example in
`/usr/bin`) disables in-app updates; replace it manually instead. Edit the
credentials before enabling the service. This template uses the pure server and
needs no desktop session or virtual display.

### Arch Linux (AUR)

```bash
yay -S rclone-manager-server
```

The package installs the server to `/usr/bin` with its menu entry, the systemd
unit, and the `rclone-manager` service user (home `/var/lib/rclone-manager`). It
depends only on `glibc`, `gcc-libs` and `dbus`. On a desktop, start it from the
menu. As a service, put `RCLONE_MANAGER_USER` and `RCLONE_MANAGER_PASS` in
`/etc/rclone-manager/server.env` (mode 600), then run
`sudo systemctl enable --now rclone-manager-server`. Pacman owns the executable, so
the application only announces new versions; update with `yay -Syu`.

## Moving from RClone Manager Headless

The server replaces the RClone Manager Headless app (0.3.6 and older). It keeps
its settings, remotes and data folder (`com.rclone.manager.headless`), and on its
first start it moves the app's start-at-login and file manager (Send To) entries
to its own name.

- **DEB and RPM:** the in-app update installs `rclone-manager-server`, which
  removes the `r-clone-manager-headless` package. The paths the old app ran from
  (`/usr/bin/rclone-manager-headless` and `rclone-manager-headless-bin`) start the
  server until the package is removed.
- **Windows setup:** the in-app update removes the old installation, keeping its
  settings, and starts the server.
- **Windows MSI:** the in-app update replaces the old MSI. Start
  **RClone Manager Server** once from the Start menu; until then, the old
  start-at-login entry points to the removed program.
- **AUR:** `rclone-manager-headless` is replaced by `rclone-manager-server`. Run
  `yay -S rclone-manager-server` once and let pacman remove the old package.

## Server packages

For live reloading of the UI, run `npm run dev:server -- --host 127.0.0.1` and
`npx ng serve --configuration headless`, then open port 1420. The DEB, RPM,
Windows setup and MSI are made from `backend/server/package/` by
`release-headless.yml`.

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
