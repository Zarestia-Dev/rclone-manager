# Configuration: Headless Server

This guide covers how to configure authentication, HTTPS/TLS, ports, and data volumes for **RClone Manager Headless**.

---

## 📋 Configuration Reference

You can configure the server using **Command Line Arguments** (Systemd/Binary) or **Environment Variables** (Docker).

| Feature | Flag (Binary/Service) | Environment Variable (Docker) | Default |
| :--- | :--- | :--- | :--- |
| **Host IP** | `--host <IP>` | `RCLONE_MANAGER_HOST` | `0.0.0.0` |
| **Port** | `--port <PORT>` | `RCLONE_MANAGER_PORT` | `8080` |
| **Username** | `--user <NAME>` | `RCLONE_MANAGER_USER` | *(None)* |
| **Password** | `--pass <PASS>` | `RCLONE_MANAGER_PASS` | *(None)* |
| **TLS Cert** | `--tls-cert <PATH>` | `RCLONE_MANAGER_TLS_CERT` | *(None)* |
| **TLS Key** | `--tls-key <PATH>` | `RCLONE_MANAGER_TLS_KEY` | *(None)* |
| **Log Level** | *(N/A)* | `RUST_LOG` | `info` |

---

## 🐳 Docker Configuration

The official [`docker-compose.yml`](https://raw.githubusercontent.com/Zarestia-Dev/rclone-manager/refs/heads/master/docker-compose.yml) uses **Profiles** to switch between modes easily.

### 📂 Persisting Data (Required for all profiles)
To ensure your Rclone remotes and settings are saved, you must map these volumes:

| Volume Name | Container Path | Description |
| :--- | :--- | :--- |
| **Config** | `/home/rclone-manager/.config/rclone` | Stores `rclone.conf` (Remotes) |
| **Data** | `/home/rclone-manager/.local/share/com.rclone.manager.headless` | Stores app settings, logs, and job history |
| **Certs** | `/app/certs` | *(Optional)* Read-only path for TLS certificates |

### Profile 1: Default (No Auth)
Standard HTTP setup on port `8080`.

* **Command:** `docker-compose up -d`
* **URL:** `http://localhost:8080`

### Profile 2: Authentication (`auth`)
Secures the UI with a Basic Auth username and password.

* **Command:** `docker-compose --profile auth up -d`
* **Configuration:**
    Edit the environment variables in the `rclone-manager-auth` service:
    ```yaml
    environment:
      - RCLONE_MANAGER_USER=admin
      - RCLONE_MANAGER_PASS=changeme123  # <--- UPDATE THIS
    ```

### Profile 3: HTTPS / TLS (`tls`)
Runs the server with encryption. Note that this profile listens on port **8443** by default.

* **Command:** `docker-compose --profile tls up -d`
* **URL:** `https://localhost:8443`
* **Setup:**
    1. Place your `cert.pem` and `key.pem` files in a `./certs` folder on your host.
    2. Ensure the volume mapping exists in your compose file:
       ```yaml
       volumes:
         - ./certs:/app/certs:ro
       ```

---

## ⚙️ Systemd Service Configuration

If you installed via the `.deb`, `.rpm`, or script, the service is managed by systemd. Service [file](https://raw.githubusercontent.com/Zarestia-Dev/rclone-manager/master/headless/rclone-manager-headless.service).

**1. Edit the Service:**
```bash
sudo nano /etc/systemd/system/rclone-manager-headless.service

```

**2. Modify the `ExecStart` line:**
Find the `[Service]` section. Add or remove flags to change the configuration.

*Example: Changing port to 3000 and setting a custom password.*

```ini
[Service]
# ...
ExecStart=/usr/bin/rclone-manager-headless \
    --host 0.0.0.0 \
    --port 3000 \
    --user admin \
    --pass MySecretPass
# ...

```

**3. Apply Changes:**

```bash
sudo systemctl daemon-reload
sudo systemctl restart rclone-manager-headless

```

---

## ⚠️ Important: OAuth Port 53682

When adding remotes that require browser authentication (like Google Drive, OneDrive, or Dropbox), Rclone needs to receive a callback token.

* **Docker Users:** You **must** expose port `53682` (it is included in our default `docker-compose.yml`).
* **Firewall:** Ensure your firewall (UFW/IPTables) allows incoming traffic on port `53682`.

If this port is blocked, the authentication tab in your browser will hang or show "Connection Refused."

---

## 🔧 Troubleshooting

<details>
<summary><b>Docker Healthcheck Failing?</b></summary>

The Docker container includes a healthcheck.

* **Default Profile:** Checks `http://localhost:8080/api/health`
* **Auth Profile:** Checks using `curl -u user:pass ...`
* **TLS Profile:** Checks `https://...` with `-k` (insecure) to support self-signed certs.

If the container shows `unhealthy`, check the logs:

```bash
docker logs rclone-manager-headless

```

</details>

<details>
<summary><b>Systemd Service Won't Start?</b></summary>

Because RClone Manager uses Tauri/GTK, it requires a virtual display.

1. Ensure `Xvfb` is installed on your system.
2. Ensure the service file includes:
```ini
Environment="DISPLAY=:99"

```



</details>
