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
#   PGIDS                 — Supplementary group IDs, comma-separated (e.g. 1000,3000)
#   RCLONE_MANAGER_HOST   — Bind address (default: 0.0.0.0)
#   RCLONE_MANAGER_PORT   — Listen port (default: 8080)
#   RCLONE_MANAGER_USER   — Basic auth username
#   RCLONE_MANAGER_PASS   — Basic auth password
#   RCLONE_MANAGER_SECRET — Master password for rcman encrypted credentials
#   RCLONE_MANAGER_SECRET_PATH — If file exists and SECRET is unset, treat as password file (Docker secret). Otherwise, custom path for encrypted credential store.
#   RCLONE_MANAGER_SECRET_FILE — Explicit password file path for rcman encrypted credentials
#   RCLONE_MANAGER_TLS_CERT / RCLONE_MANAGER_TLS_KEY — TLS certificate paths
#
# Volumes:
#   /data                 — Persistent storage (rclone binary, app data)
#   /config               — Rclone configuration directory
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build (frontend + backend via Cargo)
# -----------------------------------------------------------------------------
FROM node:bookworm AS builder

# Install Rust toolchain and native build dependencies required by the server
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        fuse3 \
        libdbus-1-dev \
        libclang-dev \
        libssl-dev \
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
RUN npm run build && cargo build --manifest-path src-tauri/Cargo.toml \
    --release --no-default-features --features web-server

# -----------------------------------------------------------------------------
# Stage 2: Runtime
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim

LABEL maintainer="Zarestia-Dev" \
      org.opencontainers.image.title="RClone Manager" \
      org.opencontainers.image.description="Web-based rclone management interface (headless)" \
      org.opencontainers.image.source="https://github.com/Zarestia-Dev/rclone-manager"

# Install runtime dependencies
# Note: 'setpriv' (util-linux) is used for privilege dropping in the entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libdbus-1-3 \
        fuse3 \
        gosu \
        openssl \
        unzip \
        util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && (sed -i 's/#\s*user_allow_other/user_allow_other/' /etc/fuse.conf 2>/dev/null || true)

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
COPY --from=builder /app/src-tauri/target/release/rclone-manager /usr/local/bin/rclone-manager-headless

# Copy the built frontend assets
# Keep the installed resource directory shared with native headless packages.
COPY --from=builder \
    ["/app/dist/rclone-manager/browser", "/usr/lib/RClone Manager Headless/browser/"]
COPY --from=builder \
    ["/app/resources/i18n", "/usr/lib/RClone Manager Headless/i18n/"]

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

# Environment variables for application storage and rclone
ENV HOME=/home/rclone-manager \
    XDG_DATA_HOME=/home/rclone-manager/.local/share \
    XDG_CONFIG_HOME=/home/rclone-manager/.config \
    RCLONE_CONFIG=/config/rclone.conf \
    RCLONE_MANAGER_INSTALLATION_TYPE=docker \
    RCLONE_MANAGER_DATA_DIR=/data \
    RCLONE_MANAGER_LOG_DIR=/data/logs \
    RCLONE_MANAGER_CACHE_DIR=/data/cache

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
