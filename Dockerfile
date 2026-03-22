# =============================================================================
# RClone Manager Headless — Multi-stage Docker Build
# =============================================================================
#
# Usage:
#   docker build -t rclone-manager .
#   docker run -d -p 8080:8080 -v rclone-data:/data -v rclone-config:/config rclone-manager
#
# Environment variables:
#   PUID / PGID           — Set container user/group ID (default: 1000)
#   RCLONE_MANAGER_HOST   — Bind address (default: 0.0.0.0)
#   RCLONE_MANAGER_PORT   — Listen port (default: 8080)
#   RCLONE_MANAGER_USER   — Basic auth username
#   RCLONE_MANAGER_PASS   — Basic auth password
#   RCLONE_MANAGER_TLS_CERT / RCLONE_MANAGER_TLS_KEY — TLS certificate paths
#   RCLONE_MANAGER_FUSE_COMPAT — Enable to skip modification time updates (for Unraid/FUSE)
#
# Volumes:
#   /data                 — Persistent storage (rclone binary, app data)
#   /config               — Rclone configuration directory
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build (frontend + backend via Tauri)
# -----------------------------------------------------------------------------
FROM node:bookworm AS builder

# Install Rust toolchain and native build dependencies required by Tauri/GTK
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        fuse3 \
        libayatana-appindicator3-dev \
        libdbus-1-dev \
        libgtk-3-dev \
        libjavascriptcoregtk-4.1-dev \
        libsoup-3.0-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain nightly --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

# Install npm dependencies first to leverage Docker layer caching
COPY package*.json ./
RUN npm ci

# Copy project source and build headless binary
COPY . .
RUN npm run tauri build -- \
    --config src-tauri/tauri.conf.headless.json \
    --config '{"bundle":{"createUpdaterArtifacts":false}}' \
    --features web-server,updater \
    --no-bundle

# -----------------------------------------------------------------------------
# Stage 2: Runtime
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim

LABEL maintainer="Zarestia-Dev" \
      org.opencontainers.image.title="RClone Manager" \
      org.opencontainers.image.description="Web-based rclone management interface (headless)" \
      org.opencontainers.image.source="https://github.com/Zarestia-Dev/rclone-manager"

# Install runtime dependencies
# Note: 'gosu' is used for privilege dropping in the entrypoint
# Note: 'xvfb' and 'dbus-x11' trick Tauri into running without a physical display
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dbus-x11 \
        fuse3 \
        gosu \
        libayatana-appindicator3-1 \
        libgtk-3-0 \
        libwebkit2gtk-4.1-0 \
        openssl \
        unzip \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# Create the internal app user
# The default UID/GID is 1000, but is dynamically overridden by PUID/PGID in entrypoint.sh
RUN groupadd -g 1000 rclone-manager \
    && useradd -m -u 1000 -g rclone-manager -s /bin/bash rclone-manager

# Create required directories and set baseline ownership
RUN mkdir -p \
        /app/certs \
        /config \
        /data \
        /home/rclone-manager/.local/share/com.rclone.manager.headless \
        /home/rclone-manager/.config/rclone \
    && chown -R rclone-manager:rclone-manager \
        /app \
        /config \
        /data \
        /home/rclone-manager

WORKDIR /app

# Copy the built backend binary
COPY --from=builder /app/src-tauri/target/release/rclone-manager-headless /usr/local/bin/

# Copy the built frontend assets
# The destination path is critical: it must exactly match the `productName` defined in tauri.conf.headless.json
COPY --from=builder \
    ["/app/src-tauri/target/release/browser", "/usr/lib/RClone Manager Headless/browser/"]
COPY --from=builder \
    ["/app/src-tauri/target/release/i18n", "/usr/lib/RClone Manager Headless/i18n/"]

# Copy and setup the runtime entrypoint script
# Moving this to the end ensures that changes to entrypoint.sh don't invalidate 
# the heavy compilation layers above.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080 53682

# Healthcheck ensures the container marks itself unhealthy if the API stops responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD if [ -n "$RCLONE_MANAGER_TLS_CERT" ]; then \
          curl -sfk https://localhost:${RCLONE_MANAGER_PORT:-8080}/health || exit 1; \
        else \
          curl -sf http://localhost:${RCLONE_MANAGER_PORT:-8080}/health || exit 1; \
        fi

# Define mount points for persistent storage
# /data: Application local data and runtime-downloaded rclone binary
# /config: User's rclone.conf configuration file
VOLUME ["/data", "/config"]

# Environment variables needed by Tauri/GTK and rclone
ENV DISPLAY=:99 \
    HOME=/home/rclone-manager \
    XDG_DATA_HOME=/home/rclone-manager/.local/share \
    XDG_CONFIG_HOME=/home/rclone-manager/.config \
    RCLONE_CONFIG=/config/rclone.conf \
    RCLONE_MANAGER_DATA_DIR=/data \
    RCLONE_MANAGER_CACHE_DIR=/data/cache

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
